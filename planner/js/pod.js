/**
 * The pod as a physical object, not just a name in the fabric.
 *
 * `fabric.js` already had pods: when the design runs three tiers, leaves are
 * grouped into pods and each pod gets its own spine layer. But that grouping
 * was purely logical -- it decided which switch talked to which, and then
 * placement scattered the racks of a pod anywhere in the room that suited the
 * fiber objective. A "pod" whose racks are not next to each other is not a pod;
 * it is a VLAN.
 *
 * Making it physical buys two things.
 *
 * The first is the reason every AI hall is now built this way: a pod is the unit
 * of repeatable construction. Its racks, its CDU, its network racks and its
 * power district are adjacent, so coolant loops are short, the spine sits among
 * the leaves it serves, and the whole assembly can be replicated down the hall
 * without redesigning anything.
 *
 * The second is search space. Placement is a QAP, which is NP-hard, and the
 * cost of a solve grows with the number of (rack, position) pairs the annealer
 * has to consider. Constraining a rack to its own pod's block of floor cuts that
 * enormously -- 12 racks over 68 positions is 816 pairs; the same racks in two
 * pods of 34 positions is 408. The hierarchy is not just tidier, it is a smaller
 * problem, which is exactly the argument for hierarchical floorplanning in the
 * first place.
 *
 * Regions are carved by recursive bisection -- the slicing floorplan from VLSI
 * -- because it is the structure that guarantees what a pod needs: every region
 * is contiguous, they tile the floor exactly, and none of them overlap.
 */
(function (root) {
  const DCP = (root.DCP = root.DCP || {});

  const floorTo = (v, dp) => Math.floor(v * 10 ** dp) / 10 ** dp;
  const ceilTo = (v, dp) => Math.ceil(v * 10 ** dp) / 10 ** dp;

  /**
   * Should the hierarchy run at all?
   *
   * Below two pods it is pure overhead: one pod spanning the whole room is the
   * unconstrained problem with extra bookkeeping, and a "pod" of two racks
   * constrains the solver without any of the locality benefit that justifies it.
   */
  function podsWanted(design, rackCount) {
    const cfg = design.pods || {};
    const per = Math.max(1, cfg.racks_per_pod || 8);
    if (cfg.enabled === false) return false;
    if (cfg.enabled === true) return rackCount >= 2;
    return rackCount >= 8 && Math.ceil(rackCount / per) >= 2;
  }

  /**
   * Group racks into pods by who talks to whom.
   *
   * Deliberately the same shape as the greedy seed in placement.js: start from
   * the busiest unassigned rack, then repeatedly pull in whichever rack talks
   * most to what the pod already holds. Network and storage racks end up in the
   * pod they serve without being told to, because that is where their traffic
   * is -- the same emergent behaviour that puts a spine in the middle of a row.
   */
  function formPods(racks, flowGroups, perPod) {
    const n = racks.length;
    const adj = Array.from({ length: n }, () => new Map());
    for (const f of flowGroups) {
      if (f.a === f.b) continue;
      adj[f.a].set(f.b, (adj[f.a].get(f.b) || 0) + f.w);
      adj[f.b].set(f.a, (adj[f.b].get(f.a) || 0) + f.w);
    }

    const podCount = Math.max(1, Math.ceil(n / perPod));
    // Spread the remainder rather than leaving a runt pod at the end: five racks
    // over two pods is 3+2, not 4+1.
    const sizes = [];
    for (let p = 0; p < podCount; p++) {
      sizes.push(Math.floor(n / podCount) + (p < n % podCount ? 1 : 0));
    }

    const assigned = new Int32Array(n).fill(-1);
    const totalFlow = racks.map((_, i) => DCP.Util.sum([...adj[i].values()]));

    for (let p = 0; p < podCount; p++) {
      const members = [];
      // Seed: the busiest rack not yet spoken for. Ties break on index so the
      // whole thing stays deterministic.
      let seed = -1;
      let seedF = -Infinity;
      for (let i = 0; i < n; i++) {
        if (assigned[i] >= 0) continue;
        if (totalFlow[i] > seedF) {
          seedF = totalFlow[i];
          seed = i;
        }
      }
      if (seed < 0) break;
      assigned[seed] = p;
      members.push(seed);

      while (members.length < sizes[p]) {
        let pick = -1;
        let pickF = -Infinity;
        for (let i = 0; i < n; i++) {
          if (assigned[i] >= 0) continue;
          let f = 0;
          for (const mem of members) f += adj[i].get(mem) || 0;
          // No affinity at all still has to go somewhere; fall back to the
          // rack's own traffic so the choice is stable rather than arbitrary.
          const score = f > 0 ? f : -1 / (1 + totalFlow[i]);
          if (score > pickF) {
            pickF = score;
            pick = i;
          }
        }
        if (pick < 0) break;
        assigned[pick] = p;
        members.push(pick);
      }
    }

    // Anything left over (possible when pods fill unevenly) joins the smallest.
    const pods = Array.from({ length: podCount }, () => []);
    for (let i = 0; i < n; i++) {
      if (assigned[i] < 0) {
        let smallest = 0;
        for (let p = 1; p < podCount; p++) if (pods[p].length < pods[smallest].length) smallest = p;
        assigned[i] = smallest;
      }
      pods[assigned[i]].push(i);
    }
    return pods.filter((p) => p.length);
  }

  /**
   * Recursive bisection of the position grid into one contiguous region per pod.
   *
   * Splits along whichever axis the block is currently longer in, so regions
   * stay squarish rather than degenerating into ribbons -- a pod one slot wide
   * and ten rows tall satisfies "contiguous" and defeats the entire purpose.
   * The split point is proportional to rack demand, so a pod with twice the
   * racks gets twice the floor.
   */
  function carve(posIdxs, podIdxs, demand, floor) {
    const out = new Map();

    function rec(cells, group) {
      if (group.length === 1) {
        out.set(group[0], new Set(cells));
        return;
      }
      if (!cells.length) {
        for (const g of group) if (!out.has(g)) out.set(g, new Set());
        return;
      }

      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const j of cells) {
        const p = floor.positions[j];
        if (p.x < x0) x0 = p.x;
        if (p.x > x1) x1 = p.x;
        if (p.y < y0) y0 = p.y;
        if (p.y > y1) y1 = p.y;
      }

      const half = Math.ceil(group.length / 2);
      const left = group.slice(0, half);
      const right = group.slice(half);
      const leftDemand = DCP.Util.sum(left, (g) => demand[g]);
      const share = leftDemand / Math.max(1e-9, leftDemand + DCP.Util.sum(right, (g) => demand[g]));

      // Cut across the long axis. Sorting by the cut axis (with the other axis
      // as tiebreak) is what keeps both halves contiguous.
      const byX = (x1 - x0) >= (y1 - y0);
      const sorted = [...cells].sort((a, b) => {
        const pa = floor.positions[a];
        const pb = floor.positions[b];
        return byX ? (pa.x - pb.x || pa.y - pb.y) : (pa.y - pb.y || pa.x - pb.x);
      });

      const cut = DCP.Util.clamp(Math.round(sorted.length * share), left.length, sorted.length - right.length);
      rec(sorted.slice(0, cut), left);
      rec(sorted.slice(cut), right);
    }

    rec(posIdxs, podIdxs);
    return out;
  }

  /** Flow between pods, from the rack-level flow the placement solver uses. */
  function podFlow(podOfRack, podCount, flowGroups) {
    const F = Array.from({ length: podCount }, () => new Float64Array(podCount));
    for (const f of flowGroups) {
      const a = podOfRack[f.a];
      const b = podOfRack[f.b];
      if (a === undefined || b === undefined || a === b) continue;
      F[a][b] += f.w;
      F[b][a] += f.w;
    }
    return F;
  }

  /**
   * Which pod goes in which region.
   *
   * A pod-level QAP, and a tiny one -- a hall has a handful of pods, not
   * hundreds of racks -- so a greedy assignment followed by exhaustive pairwise
   * swaps until nothing improves is both fast and, at this size, essentially
   * always optimal. Reaching for the annealer here would be ceremony.
   */
  function assignRegions(F, centroids, order) {
    const k = order.length;
    const assign = order.slice();
    if (k < 2) return assign;

    const D = Array.from({ length: k }, (_, a) =>
      Float64Array.from({ length: k }, (_, b) =>
        Math.abs(centroids[a].x - centroids[b].x) + Math.abs(centroids[a].y - centroids[b].y)));

    const score = (a) => {
      let v = 0;
      for (let i = 0; i < k; i++) {
        for (let j = i + 1; j < k; j++) v += F[i][j] * D[a[i]][a[j]];
      }
      return v;
    };

    let best = score(assign);
    for (let pass = 0; pass < 8; pass++) {
      let improved = false;
      for (let i = 0; i < k; i++) {
        for (let j = i + 1; j < k; j++) {
          [assign[i], assign[j]] = [assign[j], assign[i]];
          const v = score(assign);
          if (v < best - 1e-9) {
            best = v;
            improved = true;
          } else {
            [assign[i], assign[j]] = [assign[j], assign[i]];
          }
        }
      }
      if (!improved) break;
    }
    return assign;
  }

  /**
   * @param {object} spec {design, floor, racks, flowGroups}
   * @returns pods, plus `regionOf(rackId)` for the constraint mask.
   */
  function plan(spec) {
    const { design, floor, racks, flowGroups } = spec;
    const notes = [];
    const n = racks.length;
    const m = floor.positions.length;

    if (!n || !m || !podsWanted(design, n)) {
      return { enabled: false, pods: [], regionOf: null, podOf: () => null, notes };
    }

    const perPod = Math.max(1, (design.pods && design.pods.racks_per_pod) || 8);
    const members = formPods(racks, flowGroups || [], perPod);
    if (members.length < 2) {
      return { enabled: false, pods: [], regionOf: null, podOf: () => null, notes };
    }

    const podOfRack = new Int32Array(n);
    members.forEach((list, p) => list.forEach((i) => (podOfRack[i] = p)));

    // Carve the floor into as many regions as there are pods, then decide which
    // pod lands in which -- carving and assignment are separate so the geometry
    // is not biased by the order pods happened to be formed in.
    const allPos = Array.from({ length: m }, (_, j) => j);
    const demand = members.map((list) => list.length);
    const regions = carve(allPos, members.map((_, p) => p), demand, floor);

    const centroids = members.map((_, p) => {
      const cells = [...(regions.get(p) || [])];
      if (!cells.length) return { x: 0, y: 0 };
      return {
        x: DCP.Util.sum(cells, (j) => floor.positions[j].x) / cells.length,
        y: DCP.Util.sum(cells, (j) => floor.positions[j].y) / cells.length,
      };
    });

    const F = podFlow(podOfRack, members.length, flowGroups || []);
    const order = assignRegions(F, centroids, members.map((_, p) => p));

    const rackRegion = new Map();
    const pods = members.map((list, p) => {
      const regionIdx = order[p];
      const cells = regions.get(regionIdx) || new Set();
      for (const i of list) rackRegion.set(racks[i].id, cells);

      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const j of cells) {
        const pos = floor.positions[j];
        if (pos.x < x0) x0 = pos.x;
        if (pos.x > x1) x1 = pos.x;
        if (pos.y < y0) y0 = pos.y;
        if (pos.y > y1) y1 = pos.y;
      }
      // Rounded outward, never inward. These are the extremes of the positions
      // the pod owns, so rounding x0 up by half a millimetre reports a box that
      // excludes a rack standing exactly on it -- which reads downstream as a
      // containment violation that never happened.
      const bounds = cells.size ? {
        x0: floorTo(x0, 2), x1: ceilTo(x1, 2),
        y0: floorTo(y0, 2), y1: ceilTo(y1, 2),
      } : null;

      if (!cells.size) {
        notes.push(`POD-${DCP.Util.pad(p + 1)} was carved an empty region — ` +
          `the room has fewer usable positions than pods`);
      } else if (cells.size < list.length) {
        notes.push(`POD-${DCP.Util.pad(p + 1)} holds ${list.length} racks but its region ` +
          `has only ${cells.size} position(s)`);
      }

      return {
        id: `pod${DCP.Util.pad(p + 1)}`,
        name: `POD-${DCP.Util.pad(p + 1)}`,
        index: p,
        region: regionIdx,
        rack_ids: list.map((i) => racks[i].id),
        rack_names: list.map((i) => racks[i].name),
        racks: list.length,
        kw: DCP.Util.round(DCP.Util.sum(list, (i) => racks[i].kw || 0), 1),
        weight_kg: DCP.Util.round(DCP.Util.sum(list, (i) => racks[i].weight_kg || 0), 1),
        positions: cells.size,
        bounds,
      };
    });

    return {
      enabled: true,
      pods,
      notes,
      pod_of_rack: podOfRack,
      regionOf: (rackId) => rackRegion.get(rackId) || null,
      podOf: (rackId) => pods.find((p) => p.rack_ids.includes(rackId)) || null,
    };
  }

  DCP.Pod = { plan, formPods, carve, assignRegions, podFlow, podsWanted };
})(typeof globalThis !== "undefined" ? globalThis : this);
