/**
 * The build pipeline. Pure function of (design) → model.
 *
 *   logical topology ─▶ traffic matrix
 *          │
 *          ▼
 *   graph partitioning        (partition.js — which server in which rack)
 *          │
 *          ▼
 *   fabric construction       (fabric.js — switch counts, ports, logical links)
 *          │
 *          ▼
 *   rack elevation            (here — U assignment, kW, weight)
 *          │
 *          ▼
 *   QAP rack placement        (placement.js — multi-objective: traffic + cable)
 *          │
 *          ▼
 *   cooling + power siting    (cooling.js, power.js)
 *          │
 *          ▼
 *   pathway routing & bundling(pathways.js — A*, Steiner, congestion, A/B diversity)
 *          │
 *          ▼
 *   media selection, costing, validation, YAML
 *
 * Nothing downstream mutates an earlier stage, so any stage can be inspected on
 * its own -- which is what makes the optimization report trustworthy.
 */
(function (root) {
  const DCP = (root.DCP = root.DCP || {});

  const U_METRE = 0.04445;      // 1U in metres, for intra-rack cable estimates
  const DRESS_M = 1.4;          // slack for dressing a cable inside a frame
  const OBJ_TRAFFIC = 0.5;      // multi-objective weights: traffic locality …
  const OBJ_CABLE = 0.5;        // … vs total cable length

  function build(design) {
    const C = DCP.Catalog;
    const warnings = [];
    const floor = DCP.Floor.plan(design);

    /* ------------------------------------------- 1. fleet + traffic ------ */
    const fleet = DCP.Graph.buildFleet(design);
    const traffic = DCP.Graph.trafficMatrix(design, fleet);

    /* --------------------------------------------- 2. partitioning ------- */
    const computeRacks = fleet.computeRacks;
    const rankIdx = fleet.servers.filter((s) => s.jobRank).map((s) => s.index);
    const rankPos = new Map(rankIdx.map((v, i) => [v, i]));
    const rankEdges = traffic.edges
      .filter((e) => rankPos.has(e.a) && rankPos.has(e.b))
      .map((e) => ({ a: rankPos.get(e.a), b: rankPos.get(e.b), w: e.w }));

    let partitionResult = { part: new Int32Array(rankIdx.length), cut: 0, baselineCut: 0, levels: 0 };
    const assignment = new Map(); // server index → rack id
    for (const s of fleet.servers) assignment.set(s.index, s.rackId);

    if (design.optimizer.partition && computeRacks.length > 1 && rankIdx.length > 0) {
      partitionResult = DCP.Partition.partition(
        rankIdx.length, rankEdges, computeRacks.map((r) => r.capacity),
        { seed: design.optimizer.seed }
      );
      rankIdx.forEach((serverIdx, i) => {
        const rack = computeRacks[partitionResult.part[i]];
        if (rack) assignment.set(serverIdx, rack.rackId);
      });
    } else if (rankIdx.length) {
      partitionResult.cut = DCP.Partition.cutOf(rankEdges, partitionResult.part.fill(0));
      partitionResult.baselineCut = partitionResult.cut;
    }

    /* ------------------------------------- 3. materialize rack contents --- */
    const counters = { gpu: 0, cpu: 0, storage: 0, mgmt: 0, nvlink: 0 };
    const nameFor = (cls) => {
      counters[cls] = (counters[cls] || 0) + 1;
      const prefix = { gpu: "worker", cpu: "cpu", storage: "store", mgmt: "mgmt", nvlink: "nvsw" }[cls] || "node";
      return `${prefix}${DCP.Util.pad(counters[cls], 3)}`;
    };

    const racks = design.racks.map((r) => ({
      id: r.id, name: r.name, layout: r.layout, rack_type: r.rack_type,
      pinned: r.pinned || null,
      frame: C.RACK_TYPES[r.rack_type] || C.RACK_TYPES["600-48u"],
      servers: [], devices: [], kw: 0, weight_kg: 0, u_used: 0,
    }));
    const rackById = new Map(racks.map((r) => [r.id, r]));

    // Job ranks land wherever the partitioner put them; everything else stays home.
    const grouped = DCP.Util.groupBy(fleet.servers, (s) => assignment.get(s.index));
    for (const [rackId, servers] of grouped) {
      const rack = rackById.get(rackId);
      if (!rack) continue;
      for (const s of servers) {
        const sku = C.SERVERS[s.sku];
        rack.servers.push({
          name: nameFor(sku.class), sku: s.sku, kind: "server", class: sku.class,
          ru: sku.ru, kw: sku.kw, weight_kg: sku.weight_kg, gpus: sku.gpus,
          nics: sku.fabric_nics, nic_speed: sku.nic_speed, psus: sku.psus,
          busbar_powered: !!sku.busbar_powered,
        });
      }
    }

    // Companion hardware declared by the layout (e.g. NVLink switch trays).
    for (const rack of racks) {
      const layout = C.RACK_LAYOUTS[rack.layout];
      for (const comp of layout.companions || []) {
        const sku = C.SERVERS[comp.sku];
        for (let i = 0; i < comp.count; i++) {
          rack.servers.push({
            name: nameFor(sku.class), sku: comp.sku, kind: "server", class: sku.class,
            ru: sku.ru, kw: sku.kw, weight_kg: sku.weight_kg, gpus: sku.gpus,
            nics: sku.fabric_nics, nic_speed: sku.nic_speed, psus: sku.psus,
            busbar_powered: !!sku.busbar_powered, companion: true,
          });
        }
      }
      if (!DCP.Design.layoutLegalUnder(rack.layout, design.cooling.mode)) {
        warnings.push(`${rack.name}: layout "${layout.name}" cannot be deployed under ${design.cooling.mode} cooling`);
      }
    }

    /* --------------------------------------------- 4. fabric ------------- */
    const fabric = DCP.Fabric.plan({ design, racks });
    fabric.notes.forEach((n) => warnings.push(n));

    /* --------------------------------------------- 5. elevations --------- */
    for (const rack of racks) {
      elevate(rack, fabric.byRack.get(rack.id) || []);
    }

    // OOB/mgmt cabling needs the final device list.
    const oobLinks = DCP.Fabric.cableOob({ design, racks }, fabric);

    // name → {rack, U} so in-rack cable lengths come from the real elevation.
    const deviceIndex = new Map();
    for (const rack of racks) {
      for (const dev of rack.devices) deviceIndex.set(dev.name, { rackId: rack.id, u: dev.u });
    }

    /* --------------------------------------------- 6. QAP placement ------ */
    const rackIds = racks.map((r) => r.id);
    const flow = DCP.Graph.rackFlowMatrix(rackIds, mapAssignment(assignment, fleet), traffic.edges);

    // Cable-count matrix: Σ F_cable · D is literally total cable length, so this
    // term makes the placement solver a cable-length minimizer directly.
    const cableCount = Array.from({ length: rackIds.length }, () => new Float64Array(rackIds.length));
    const rackIndex = new Map(rackIds.map((id, i) => [id, i]));
    for (const link of [...fabric.links, ...oobLinks]) {
      if (link.in_rack) continue;
      const a = rackIndex.get(keyRack(link.from_key));
      const b = rackIndex.get(keyRack(link.to_key));
      if (a === undefined || b === undefined || a === b) continue;
      cableCount[a][b] += 1;
      cableCount[b][a] += 1;
    }

    const trafficSum = Math.max(1e-9, sumMatrix(flow.F));
    const cableSum = Math.max(1e-9, sumMatrix(cableCount));
    const wTraffic = design.optimizer.objective_traffic_weight ?? OBJ_TRAFFIC;
    const wCable = 1 - wTraffic;
    const F = Array.from({ length: rackIds.length }, (_, i) =>
      Float64Array.from({ length: rackIds.length }, (_, j) =>
        (wTraffic * flow.F[i][j]) / trafficSum + (wCable * cableCount[i][j]) / cableSum));

    const pins = {};
    racks.forEach((r, i) => {
      if (!r.pinned) return;
      const p = DCP.Floor.nearestPosition(floor, r.pinned.x, r.pinned.y);
      if (p) pins[i] = floor.positions.indexOf(p);
    });

    let placement = { posOf: new Int32Array(racks.length), cost: 0, baseline: 0, method: "none", stats: {} };
    if (floor.positions.length >= racks.length && racks.length > 0) {
      placement = DCP.Placement.place(F, floor.positions, {
        method: design.optimizer.placement,
        seed: design.optimizer.seed,
        iters: design.optimizer.anneal_iters,
        t0: design.optimizer.anneal_start_t,
        t1: design.optimizer.anneal_end_t,
        pins,
        frozen: Object.keys(pins).map(Number),
      });
    } else if (racks.length) {
      warnings.push(`room holds ${floor.positions.length} rack positions but the design has ${racks.length} racks`);
      racks.forEach((r, i) => {
        placement.posOf[i] = Math.min(i, Math.max(0, floor.positions.length - 1));
      });
    }

    const usedPositions = new Set();
    racks.forEach((rack, i) => {
      const pos = floor.positions[placement.posOf[i]];
      if (!pos) return;
      rack.x = pos.x;
      rack.y = pos.y;
      rack.row = pos.row;
      rack.slot = pos.slot;
      rack.facing = pos.facing;
      rack.position = pos.id;
      usedPositions.add(pos.id);
    });

    const freePositions = floor.positions.filter((p) => !usedPositions.has(p.id));
    const takeFreePosition = (x, y) => {
      if (!freePositions.length) return null;
      let best = 0;
      let bestD = Infinity;
      freePositions.forEach((p, i) => {
        const d = Math.abs(p.x - x) + Math.abs(p.y - y);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      const [p] = freePositions.splice(best, 1);
      usedPositions.add(p.id);
      return p;
    };

    /* --------------------------------------------- 7. cooling + power ---- */
    const ctx = { design, floor, racks, takeFreePosition };
    const cooling = DCP.Cooling.plan(ctx);
    cooling.notes.forEach((n) => warnings.push(n));
    const power = DCP.Power.plan({ ...ctx, cooling });
    power.notes.forEach((n) => warnings.push(n));

    /* --------------------------------------------- 8. routing ------------ */
    const graph = DCP.Pathways.build(floor, design);
    const equipment = [...cooling.units, ...power.ups, ...power.entrances, ...power.distribution];

    for (const rack of racks) {
      if (rack.x === undefined) continue;
      for (const tier of ["data", "power", "fluid"]) {
        DCP.Pathways.addDrop(graph[tier], `rack:${rack.id}`, rack.x, rack.y);
      }
    }
    for (const eq of equipment) {
      for (const tier of ["data", "power", "fluid"]) {
        DCP.Pathways.addDrop(graph[tier], `equip:${eq.id}`, eq.x ?? 0, eq.y ?? 0);
      }
    }
    // The facility loop header lands on the wall behind the electrical zone.
    DCP.Pathways.addDrop(graph.fluid, "facility:loop", 0.2, design.room.depth_m / 2);

    const cables = [];
    const bundles = new Map();

    // 8a. Leaf↔spine and spine↔super first: they are the trunks, and routing
    //     them before anything else gives them the uncongested pathway.
    const trunkGroups = DCP.Util.groupBy(
      fabric.links.filter((l) => l.trunk_group && !l.in_rack), (l) => l.trunk_group);
    const routedTrunk = new Set();

    if (design.optimizer.bundle) {
      for (const [group, links] of trunkGroups) {
        const rootKey = links[0].to_key;
        const terminals = [...new Set(links.map((l) => l.from_key))].filter((k) => k !== rootKey);
        if (!terminals.length) continue;
        const tree = DCP.Pathways.steiner(graph.data, rootKey, terminals, {
          congestion_weight: design.optimizer.congestion_weight,
          bend_penalty_m: design.optimizer.bend_penalty_m,
        });
        if (!tree) continue;
        bundles.set(group, {
          id: group,
          tree_length_m: DCP.Util.round(tree.length_m, 2),
          segments: tree.edges.length,
          cables: links.length,
        });
        for (const link of links) {
          const path = link.from_key === rootKey ? { length_m: 0, edges: [] } : tree.paths.get(link.from_key);
          if (!path) continue;
          cables.push(finishCable(design, graph.data, link, path, group));
          routedTrunk.add(link);
        }
      }
    }

    // 8b. Everything else, point to point.
    const rest = [...fabric.links, ...oobLinks].filter((l) => !routedTrunk.has(l));
    for (const link of rest) {
      cables.push(routeAndFinish(design, graph, link, "data", { deviceIndex }));
    }

    // 8c. Power, with the B feed pushed off the A feed's tray segments.
    const aPaths = new Map();
    const powerRuns = [...power.runs].sort((x, y) => (x.feed === "A" ? -1 : 1) - (y.feed === "A" ? -1 : 1));
    for (const run of powerRuns) {
      const avoid = run.feed === "B" && run.pair_key ? aPaths.get(run.pair_key) : null;
      const cable = routeAndFinish(design, graph, run, "power", { avoid, deviceIndex });
      if (run.feed === "A" && run.pair_key && cable.path_segments) {
        aPaths.set(run.pair_key, new Set(cable.path_segments));
      }
      cables.push(cable);
    }

    // 8d. Coolant.
    for (const run of cooling.runs) {
      cables.push(routeAndFinish(design, graph, run, "fluid", { deviceIndex }));
    }

    /* --------------------------------------------- 9. rollups ------------ */
    const model = {
      design, floor, fleet, traffic, fabric, cooling, power, graph,
      racks, equipment, cables,
      bundles: [...bundles.values()],
      warnings,
      optimization: {
        partition: {
          enabled: !!design.optimizer.partition,
          levels: partitionResult.levels,
          cut_gbps: DCP.Util.round(partitionResult.cut, 1),
          baseline_cut_gbps: DCP.Util.round(partitionResult.baselineCut, 1),
          improvement_pct: pct(partitionResult.baselineCut, partitionResult.cut),
          internal_gbps: DCP.Util.round(flow.internal, 1),
        },
        placement: {
          method: placement.method,
          objective: DCP.Util.round(placement.cost, 6),
          baseline_objective: DCP.Util.round(placement.baseline, 6),
          improvement_pct: pct(placement.baseline, placement.cost),
          traffic_weight: wTraffic,
          cable_weight: DCP.Util.round(wCable, 3),
          ...placement.stats,
        },
        routing: {
          method: design.optimizer.routing,
          congestion_weight: design.optimizer.congestion_weight,
          bend_penalty_m: design.optimizer.bend_penalty_m,
          data_tray: DCP.Pathways.utilization(graph.data),
          power_tray: DCP.Pathways.utilization(graph.power),
        },
        bundling: {
          enabled: !!design.optimizer.bundle,
          trunks: bundles.size,
          trunk_length_m: DCP.Util.round(DCP.Util.sum([...bundles.values()], (b) => b.tree_length_m), 1),
        },
      },
    };

    model.totals = rollup(model);
    model.validation = DCP.Validate.check(model);
    return model;
  }

  /* ------------------------------------------------------------ helpers -- */

  function keyRack(key) {
    return key && key.startsWith("rack:") ? key.slice(5) : null;
  }

  function mapAssignment(assignment, fleet) {
    const out = {};
    for (const s of fleet.servers) out[s.index] = assignment.get(s.index);
    return out;
  }

  function sumMatrix(M) {
    let s = 0;
    for (const row of M) for (const v of row) s += v;
    return s;
  }

  function pct(base, now) {
    if (!base) return 0;
    return DCP.Util.round(((base - now) / base) * 100, 1);
  }

  /**
   * U assignment: network gear at the top (patching lives there), compute from
   * the bottom up, companion trays banded into the middle of the compute stack
   * the way an NVL72 puts its NVLink trays between compute groups.
   */
  function elevate(rack, switches) {
    const height = rack.frame.u;
    const devices = [];
    let top = height;

    const ordered = [...switches].sort((a, b) => rank(a.role) - rank(b.role));
    for (const sw of ordered) {
      const u = top - sw.ru + 1;
      devices.push({
        name: sw.name, sku: sw.sku, kind: "switch", role: sw.role, model: sw.model,
        u, ru: sw.ru, kw: sw.kw, weight_kg: sw.weight_kg, ports: sw.ports,
        rail: sw.rail, class: "switch",
      });
      top -= sw.ru;
    }

    const companions = rack.servers.filter((s) => s.companion);
    const primary = rack.servers.filter((s) => !s.companion);
    const half = Math.ceil(primary.length / 2);
    const sequence = companions.length
      ? [...primary.slice(0, half), ...companions, ...primary.slice(half)]
      : primary;

    let u = 1;
    for (const s of sequence) {
      devices.push({
        name: s.name, sku: s.sku, kind: "server", role: s.class, model: DCP.Catalog.SERVERS[s.sku].model,
        u, ru: s.ru, kw: s.kw, weight_kg: s.weight_kg, gpus: s.gpus, nics: s.nics,
        nic_speed: s.nic_speed, psus: s.psus, busbar_powered: s.busbar_powered, class: s.class,
      });
      u += s.ru;
    }

    devices.sort((a, b) => b.u - a.u);
    rack.devices = devices;
    rack.u_used = DCP.Util.sum(devices, (d) => d.ru);
    rack.u_height = height;
    rack.kw = DCP.Util.round(DCP.Util.sum(devices, (d) => d.kw), 2);
    rack.weight_kg = DCP.Util.round(rack.frame.weight_kg + DCP.Util.sum(devices, (d) => d.weight_kg), 1);
    rack.gpus = DCP.Util.sum(devices, (d) => d.gpus || 0);
    rack.top_free_u = top;
  }

  function rank(role) {
    return { oob: 0, super: 1, spine: 2, leaf: 3 }[role] ?? 4;
  }

  /**
   * Intra-rack cables never touch a tray: they run up the vertical manager and
   * back, so the length is the U separation plus the trip out to the manager.
   * Dressing already includes the service loop, so no extra slack is added --
   * adding it pushed 3 m in-rack jumpers onto 5 m+ media in an earlier pass.
   */
  function inRackLength(link, deviceIndex) {
    const a = deviceIndex.get(link.a && link.a.device);
    const b = deviceIndex.get(link.b && link.b.device);
    const du = a && b ? Math.abs(a.u - b.u) : 12;
    return DCP.Util.round(du * U_METRE + DRESS_M, 2);
  }

  function routeAndFinish(design, graph, link, tier, opts = {}) {
    if (link.in_rack || link.from_key === link.to_key) {
      return finishCable(design, graph[tier], link,
        { length_m: inRackLength(link, opts.deviceIndex || new Map()), edges: [], bends: 0 }, null,
        { noSlack: true });
    }
    const g = graph[tier];
    let path = null;

    if (opts.avoid && opts.avoid.size) {
      // Yen's K-shortest, then keep whichever candidate shares the fewest tray
      // segments with the A feed -- that is the diversity constraint made real.
      const cands = DCP.Pathways.kShortest(g, link.from_key, link.to_key, 4, {
        congestion_weight: design.optimizer.congestion_weight,
        bend_penalty_m: design.optimizer.bend_penalty_m,
        avoid: opts.avoid,
      });
      let best = null;
      for (const c of cands) {
        const shared = c.edges.filter((e) => opts.avoid.has(e)).length;
        const score = shared * 1000 + c.length_m;
        if (!best || score < best.score) best = { c, score, shared };
      }
      path = best ? best.c : null;
      if (best) link.shared_segments_with_a = best.shared;
    } else {
      path = DCP.Pathways.route(g, link.from_key, link.to_key, {
        congestion_weight: design.optimizer.congestion_weight,
        bend_penalty_m: design.optimizer.bend_penalty_m,
      });
    }

    if (!path) {
      return finishCable(design, g, { ...link, unroutable: true },
        { length_m: 0, edges: [], bends: 0 }, null);
    }
    return finishCable(design, g, link, path, null);
  }

  /** Length → media → cost, then commit the cross-section into the trays. */
  function finishCable(design, g, link, path, bundleId, opts = {}) {
    const C = DCP.Catalog;
    const slack = opts.noSlack ? 0 : design.optimizer.slack_m * 2;
    const length = DCP.Util.round(path.length_m + slack, 2);

    let media = link.media;
    if (!media) media = C.pickMedia(link.speed || 400, length);

    const spec = C.MEDIA[media] || C.POWER_MEDIA[media] || C.COOLANT_MEDIA[media];
    const od = spec ? spec.od_mm : 6;
    // Conduit-borne runs (service feeders) are routed for length but never
    // charged against tray fill.
    if (path.edges && path.edges.length && link.pathway !== "conduit") {
      DCP.Pathways.reserve(g, path.edges, od);
    }

    return {
      label: link.label,
      class: link.class,
      media: media || "UNREACHABLE",
      media_name: spec ? spec.name : null,
      speed_gbps: link.speed || null,
      length_m: length,
      bends: path.bends || 0,
      a: link.a,
      b: link.b,
      rail: link.rail,
      tier: link.tier,
      feed: link.feed,
      bundle: bundleId || link.trunk_group || null,
      in_rack: !!link.in_rack,
      pathway: link.pathway || (link.in_rack ? "in-rack" : "tray"),
      unroutable: !!link.unroutable,
      shared_segments_with_a: link.shared_segments_with_a,
      cost_usd: spec ? spec.cost_usd : 0,
      path_segments: path.edges || [],
    };
  }

  function rollup(model) {
    const { racks, cables, cooling, power, fabric } = model;
    const byClass = DCP.Util.groupBy(cables, (c) => c.class);
    const cableSummary = {};
    for (const [cls, list] of byClass) {
      cableSummary[cls] = {
        count: list.length,
        length_m: DCP.Util.round(DCP.Util.sum(list, (c) => c.length_m), 1),
        cost_usd: DCP.Util.round(DCP.Util.sum(list, (c) => c.cost_usd), 0),
      };
    }
    const byMedia = DCP.Util.groupBy(cables, (c) => c.media);
    const mediaSummary = {};
    for (const [m, list] of byMedia) {
      mediaSummary[m] = {
        count: list.length,
        length_m: DCP.Util.round(DCP.Util.sum(list, (c) => c.length_m), 1),
        cost_usd: DCP.Util.round(DCP.Util.sum(list, (c) => c.cost_usd), 0),
      };
    }

    const gpus = DCP.Util.sum(racks, (r) => r.gpus || 0);
    const itKw = DCP.Util.sum(racks, (r) => r.kw);
    const area = model.floor.area_m2;

    return {
      racks: racks.length,
      gpus,
      servers: DCP.Util.sum(racks, (r) => r.devices.filter((d) => d.kind === "server").length),
      switches: fabric.switches.length,
      cables: cables.length,
      cable_length_m: DCP.Util.round(DCP.Util.sum(cables, (c) => c.length_m), 1),
      cable_cost_usd: DCP.Util.round(DCP.Util.sum(cables, (c) => c.cost_usd), 0),
      cables_by_class: cableSummary,
      cables_by_media: mediaSummary,
      it_load_kw: DCP.Util.round(itKw, 1),
      facility_load_kw: DCP.Util.round(itKw * model.design.power.pue_target, 1),
      power_density_kw_m2: DCP.Util.round(area ? itKw / area : 0, 2),
      cooling_capacity_kw: cooling.capacity_kw,
      cooling_mode: cooling.mode + (cooling.water_type ? `/${cooling.water_type}` : ""),
      ups_capacity_per_feed_kw: power.totals.ups_capacity_per_feed_kw,
      rack_pdus: power.totals.rack_pdu_count,
      weight_kg: DCP.Util.round(DCP.Util.sum(racks, (r) => r.weight_kg), 0),
      room_area_m2: area,
      rack_positions: model.floor.capacity,
    };
  }

  DCP.Build = { build, elevate, portsOf: null, U_METRE };
})(typeof globalThis !== "undefined" ? globalThis : this);
