/**
 * Logical topology and the traffic matrix that drives every placement decision.
 *
 *   GPU → NIC → leaf → spine → core
 *
 * The planner does not optimize against "number of cables"; it optimizes against
 * *where the bytes go*. That comes from the parallelism plan:
 *
 *   tensor-parallel (TP)   all-to-all every layer            → enormous, keep in-rack
 *   pipeline-parallel (PP) activations stage→stage           → moderate, keep in-row
 *   data-parallel (DP)     gradient/KV all-reduce ring       → large, tolerate a hop
 *   background             storage, checkpoint, mgmt         → uniform, ignorable
 *
 * Weights are in GB/s of *steady-state* demand per server pair. Absolute scale
 * does not matter to the solvers (they minimize Σ F·D), only the ratios do, but
 * keeping them in real units makes the numbers reviewable by a network engineer.
 */
(function (root) {
  const DCP = (root.DCP = root.DCP || {});

  const W_TP = 400;   // GB/s -- TP peers exchange activations every layer
  const W_PP = 40;    // GB/s -- stage boundary activations
  const W_DP = 120;   // GB/s -- all-reduce between replica peers
  const W_BASE = 400; // scaled by workload.base_affinity

  /**
   * Expand the rack list into the logical server fleet.
   * Only compute-role racks host job servers; storage/mgmt/network racks
   * contribute background traffic and their own devices, not job ranks.
   */
  function buildFleet(design) {
    const C = DCP.Catalog;
    const servers = [];
    const computeRacks = [];

    design.racks.forEach((rack) => {
      const layout = C.RACK_LAYOUTS[rack.layout];
      if (!layout || !layout.server) return;
      const sku = C.SERVERS[layout.server];
      const count = Math.max(0, Math.min(rack.servers, layout.max_servers));
      const isJobRank = sku.class === "gpu";
      if (layout.role === "compute" && isJobRank) {
        computeRacks.push({ rackId: rack.id, capacity: count, layout: rack.layout, sku: layout.server });
      }
      for (let i = 0; i < count; i++) {
        servers.push({
          index: servers.length,
          rackId: rack.id,          // initial (pre-partition) home
          sku: layout.server,
          class: sku.class,
          gpus: sku.gpus,
          nics: sku.fabric_nics,
          nic_speed: sku.nic_speed,
          jobRank: isJobRank && layout.role === "compute",
        });
      }
    });

    return { servers, computeRacks };
  }

  /**
   * Sparse server↔server demand edges. Job ranks are tiled across the fleet:
   * a job needs tp×pp×dp GPUs, so a fleet with more GPUs runs several instances
   * side by side rather than one impossibly wide job.
   */
  function trafficMatrix(design, fleet) {
    const wl = design.workload;
    const ranks = fleet.servers.filter((s) => s.jobRank);
    const edges = [];
    const add = (a, b, w) => {
      if (a === b || w <= 0) return;
      edges.push({ a: Math.min(a, b), b: Math.max(a, b), w });
    };

    if (ranks.length === 0) return { edges, jobs: 0, ranks: 0 };

    const gpusPerServer = ranks[0].gpus || 8;
    const serversPerTP = Math.max(1, Math.ceil(wl.tp_size / gpusPerServer));
    const serversPerReplica = serversPerTP * Math.max(1, wl.pp_size);
    const serversPerJob = serversPerReplica * Math.max(1, wl.dp_replicas);
    const jobs = Math.max(1, Math.floor(ranks.length / serversPerJob));

    for (let j = 0; j < jobs; j++) {
      const base = j * serversPerJob;
      if (base + serversPerJob > ranks.length) break;

      for (let d = 0; d < wl.dp_replicas; d++) {
        const rep = base + d * serversPerReplica;

        for (let p = 0; p < wl.pp_size; p++) {
          const stage = rep + p * serversPerTP;

          // TP: full mesh inside the group -- the strongest affinity in the model.
          for (let a = 0; a < serversPerTP; a++) {
            for (let b = a + 1; b < serversPerTP; b++) {
              add(ranks[stage + a].index, ranks[stage + b].index, W_TP);
            }
          }

          // PP: stage s → stage s+1, first server of each group carries it.
          if (p + 1 < wl.pp_size) {
            const next = rep + (p + 1) * serversPerTP;
            if (next + serversPerTP <= base + serversPerJob) {
              add(ranks[stage].index, ranks[next].index, W_PP);
            }
          }
        }

        // DP: all-reduce ring between replica d and d+1, stage-aligned.
        const nextRep = base + ((d + 1) % wl.dp_replicas) * serversPerReplica;
        if (wl.dp_replicas > 1 && nextRep !== rep) {
          for (let k = 0; k < serversPerReplica; k++) {
            if (rep + k < ranks.length && nextRep + k < ranks.length) {
              add(ranks[rep + k].index, ranks[nextRep + k].index, W_DP);
            }
          }
        }
      }
    }

    // Background any-to-any. Kept sparse: a ring, not a clique, so it biases
    // toward locality without swamping the job structure with O(n²) edges.
    const bg = wl.base_affinity * W_BASE;
    if (bg > 0) {
      for (let i = 0; i < fleet.servers.length; i++) {
        const j = (i + 1) % fleet.servers.length;
        add(fleet.servers[i].index, fleet.servers[j].index, bg);
      }
    }

    // Merge duplicate pairs so the partitioner sees one weight per edge.
    const merged = new Map();
    for (const e of edges) {
      const k = `${e.a}:${e.b}`;
      merged.set(k, (merged.get(k) || 0) + e.w);
    }
    const out = [...merged.entries()].map(([k, w]) => {
      const [a, b] = k.split(":").map(Number);
      return { a, b, w };
    });
    out.sort((x, y) => x.a - y.a || x.b - y.b);

    return {
      edges: out,
      jobs,
      ranks: ranks.length,
      servers_per_tp: serversPerTP,
      servers_per_replica: serversPerReplica,
      servers_per_job: serversPerJob,
      total_demand_gbps: DCP.Util.sum(out, (e) => e.w),
    };
  }

  /**
   * Collapse server demand onto racks given an assignment (serverIndex → rackId).
   * This is the F matrix in the QAP objective Σ F_ik · D_jl.
   */
  function rackFlowMatrix(rackIds, assignment, edges) {
    const idx = new Map(rackIds.map((id, i) => [id, i]));
    const n = rackIds.length;
    const F = Array.from({ length: n }, () => new Float64Array(n));
    let cut = 0;
    let internal = 0;

    for (const e of edges) {
      const ra = idx.get(assignment[e.a]);
      const rb = idx.get(assignment[e.b]);
      if (ra === undefined || rb === undefined) continue;
      if (ra === rb) {
        internal += e.w;
        continue;
      }
      F[ra][rb] += e.w;
      F[rb][ra] += e.w;
      cut += e.w;
    }
    return { F, cut, internal, index: idx };
  }

  DCP.Graph = { buildFleet, trafficMatrix, rackFlowMatrix, W_TP, W_PP, W_DP };
})(typeof globalThis !== "undefined" ? globalThis : this);
