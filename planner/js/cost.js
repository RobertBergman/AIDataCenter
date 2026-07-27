/**
 * What a layout actually costs.
 *
 * The placement solver used to minimise a dimensionless blend of traffic moment
 * and cable-count × distance. Both are proxies, and measuring the default design
 * showed how far a proxy can drift from the bill: annealing improved the reported
 * objective by 28% and moved the cable cost by exactly $0.
 *
 * The reason is that media price is a *step* function of length --
 *
 *     DAC ≤3 m $260 · AEC ≤5 m $690 · AOC ≤30 m $1450 · SMF ≤500 m $2600
 *
 * -- and a room can sit entirely on one step. Every cable carries ~5 m of fixed
 * overhead before any horizontal run (rise to the tray, a drop at each end, a
 * service loop at each end), so in a 24×16 m hall every inter-rack 400G link
 * lands between 7.3 and 9.6 m: too long for AEC, far too short to threaten SMF.
 * Shuffling racks inside that band changes the length and cannot change the
 * price.
 *
 * So this module supplies the two things the objective was missing:
 *
 *   1. a length estimate good enough to *price* a link. It comes from the real
 *      pathway graph -- rise, drops, ladder detours, end-of-row wraps -- not a
 *      Manhattan guess with a fudge factor, so the media class the solver
 *      assumes is the media class the router goes on to emit;
 *
 *   2. the step curve itself, plus the bounds that say how much of the bill
 *      placement can move at all.
 *
 * (2) is the one that matters. When the cheapest and the dearest layout cost the
 * same, the useful answer is "placement is not your lever here, the fabric
 * architecture is" -- and a planner should say that rather than report a 28% win
 * against a baseline nobody would have built anyway.
 */
(function (root) {
  const DCP = (root.DCP = root.DCP || {});

  /**
   * Price for a link nothing in the ladder reaches. Finite and rising with
   * length on purpose: an infinite penalty is a wall the annealer cannot climb,
   * whereas a steep slope still points back toward the reachable band.
   */
  const UNREACH_MULT = 4;
  const UNREACH_PER_M = 500;

  /* ------------------------------------------------------------ step curve -- */

  const stepCache = new Map();

  /** The reach ladder for one speed, cheapest-first, as {max_m, cost_usd}. */
  function reachSteps(speed) {
    if (stepCache.has(speed)) return stepCache.get(speed);
    const C = DCP.Catalog;
    const ladder = C.MEDIA_LADDER[speed] || C.MEDIA_LADDER[400];
    const steps = ladder
      .filter((k) => C.MEDIA[k])
      .map((k) => ({ key: k, max_m: C.MEDIA[k].max_m, cost_usd: C.MEDIA[k].cost_usd }))
      .sort((a, b) => a.max_m - b.max_m);
    stepCache.set(speed, steps);
    return steps;
  }

  /** Installed cost of one link of `speed` run over `len` metres. */
  function stepCost(steps, len) {
    for (const s of steps) if (s.max_m >= len) return s.cost_usd;
    const last = steps[steps.length - 1];
    if (!last) return 0;
    return last.cost_usd * UNREACH_MULT + Math.max(0, len - last.max_m) * UNREACH_PER_M;
  }

  /** Which ladder entry a length lands on -- `null` when nothing reaches. */
  function stepKey(steps, len) {
    for (const s of steps) if (s.max_m >= len) return s.key;
    return null;
  }

  /* ---------------------------------------------------- position distances -- */

  const distCache = new Map();
  const DIST_CACHE_MAX = 4;

  /**
   * Signature of everything the distance matrix depends on. Geometry only: the
   * matrix is reused across solves that change racks but not the room.
   */
  function floorSignature(floor, design) {
    const r = design.room;
    return [
      floor.positions.length, floor.slotsPerRow, floor.rows.length,
      DCP.Util.round(floor.pitch, 4), DCP.Util.round(floor.rowDepth, 4),
      DCP.Util.round(floor.usable.x0, 4), DCP.Util.round(floor.usable.x1, 4),
      floor.aisles.map((a) => DCP.Util.round(a.y, 3)).join("|"),
      r.tray_height_m, r.data_tray_runs,
    ].join(",");
  }

  /** Single-source shortest path over raw segment length (no congestion, no bends). */
  function dijkstra(g, src) {
    const N = g.nodes.length;
    const dist = new Float64Array(N).fill(Infinity);
    const seen = new Uint8Array(N);
    const heap = new DCP.Util.MinHeap();
    dist[src] = 0;
    heap.push(src, 0);

    while (heap.size) {
      const u = heap.pop();
      if (seen[u]) continue;
      seen[u] = 1;
      const du = dist[u];
      for (const { v, e } of g.adj[u]) {
        const nd = du + g.edges[e].len;
        if (nd < dist[v]) {
          dist[v] = nd;
          heap.push(v, nd);
        }
      }
    }
    return dist;
  }

  /**
   * True pathway distance between every pair of candidate rack positions, on the
   * data tier, with the trays empty.
   *
   * Empty is the right assumption at placement time: congestion is a consequence
   * of the layout we have not chosen yet, and it raises routing *cost* without
   * changing segment *length*, which is what prices the media. The residual
   * against the finished route is measured in build.js and reported, so the
   * assumption is checked rather than trusted.
   *
   * One Dijkstra per position over a graph of a few hundred nodes -- cheap, and
   * memoised on room geometry so repeated solves pay for it once.
   */
  function positionDistances(floor, design) {
    const key = floorSignature(floor, design);
    if (distCache.has(key)) return distCache.get(key);

    const m = floor.positions.length;
    const D = Array.from({ length: m }, () => new Float64Array(m));
    const result = { D, m, min_m: 0, max_m: 0, unreachable: 0 };

    if (m > 1) {
      const g = DCP.Pathways.buildTier(floor, "data", design.room.tray_height_m, design.room.data_tray_runs);
      const nodeOf = floor.positions.map((p, i) => DCP.Pathways.addDrop(g, `pos:${i}`, p.x, p.y));

      let min = Infinity;
      let max = 0;
      let unreachable = 0;

      for (let i = 0; i < m; i++) {
        const dist = dijkstra(g, nodeOf[i]);
        for (let j = 0; j < m; j++) {
          if (i === j) continue;
          const d = dist[nodeOf[j]];
          if (!Number.isFinite(d)) {
            unreachable++;
            D[i][j] = 1e6;
            continue;
          }
          D[i][j] = d;
          if (d < min) min = d;
          if (d > max) max = d;
        }
      }
      result.min_m = Number.isFinite(min) ? min : 0;
      result.max_m = max;
      result.unreachable = unreachable;
    }

    if (distCache.size >= DIST_CACHE_MAX) distCache.delete(distCache.keys().next().value);
    distCache.set(key, result);
    return result;
  }

  /* -------------------------------------------------------------- grouping -- */

  /**
   * Collapse a link list onto rack pairs: {a, b, speed, count}. One group is one
   * price lookup instead of one per cable, which is what makes the objective's
   * incremental delta O(neighbouring groups) rather than O(racks).
   *
   * Same-rack links are dropped -- they are priced off the rack elevation, not
   * the floor, so no placement can change them.
   */
  function linkGroups(rackIds, links) {
    const idx = new Map(rackIds.map((id, i) => [id, i]));
    const acc = new Map();

    for (const link of links) {
      if (link.in_rack) continue;
      const a = idx.get(rackOf(link.from_key));
      const b = idx.get(rackOf(link.to_key));
      if (a === undefined || b === undefined || a === b) continue;
      const speed = link.speed || 400;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const k = `${lo}:${hi}:${speed}`;
      const g = acc.get(k);
      if (g) g.count++;
      else acc.set(k, { a: lo, b: hi, speed, count: 1 });
    }

    return [...acc.values()].sort((x, y) => x.a - y.a || x.b - y.b || x.speed - y.speed);
  }

  function rackOf(key) {
    return key && key.startsWith("rack:") ? key.slice(5) : null;
  }

  /** Sparse rack↔rack demand from the dense flow matrix, upper triangle only. */
  function flowGroups(F) {
    const out = [];
    for (let i = 0; i < F.length; i++) {
      for (let j = i + 1; j < F.length; j++) {
        if (F[i][j] > 0) out.push({ a: i, b: j, w: F[i][j] });
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------- pricing -- */

  /** Predicted installed cost of every inter-rack link under one placement. */
  function cableCost(groups, D, posOf, slack2) {
    let usd = 0;
    for (const g of groups) {
      const steps = reachSteps(g.speed);
      usd += g.count * stepCost(steps, D[posOf[g.a]][posOf[g.b]] + slack2);
    }
    return usd;
  }

  /** Predicted routed length of every inter-rack link under one placement. */
  function cableLength(groups, D, posOf, slack2) {
    let m = 0;
    for (const g of groups) m += g.count * (D[posOf[g.a]][posOf[g.b]] + slack2);
    return m;
  }

  /**
   * How much of the cable bill placement can move at all.
   *
   * Relax the problem completely: let every rack pair sit at whatever spacing it
   * likes, ignoring that they all have to fit in the room together. A group whose
   * media class is the same at the closest and the furthest spacing the room
   * offers is *pinned* -- no arrangement changes its price, and its money is off
   * the table. What is left is the movable spend, and `leverage_usd` is the whole
   * width of the achievable range.
   *
   * The relaxation makes `lower_usd` a genuine lower bound (weak, but valid and
   * free), which is a far more honest denominator for the optimisation report
   * than "better than filling the room in list order".
   */
  function bounds(groups, dist, slack2, posOf) {
    const near = dist.min_m + slack2;
    const far = dist.max_m + slack2;

    let lower = 0;
    let upper = 0;
    let fixed = 0;
    let movable = 0;
    let current = 0;
    let pinnedGroups = 0;
    let movableGroups = 0;
    let unreachable = 0;

    for (const g of groups) {
      const steps = reachSteps(g.speed);
      const lo = g.count * stepCost(steps, near);
      const hi = g.count * stepCost(steps, far);
      lower += lo;
      upper += hi;

      const here = posOf
        ? g.count * stepCost(steps, dist.D[posOf[g.a]][posOf[g.b]] + slack2)
        : lo;
      current += here;

      if (stepKey(steps, near) === stepKey(steps, far)) {
        fixed += here;
        pinnedGroups++;
      } else {
        movable += here;
        movableGroups++;
      }
      if (posOf && stepKey(steps, dist.D[posOf[g.a]][posOf[g.b]] + slack2) === null) {
        unreachable += g.count;
      }
    }

    return {
      lower_usd: lower,
      upper_usd: upper,
      current_usd: current,
      fixed_usd: fixed,
      movable_usd: movable,
      leverage_usd: upper - lower,
      pinned_groups: pinnedGroups,
      movable_groups: movableGroups,
      unreachable_links: unreachable,
      near_m: near,
      far_m: far,
      // Distance is still worth minimising when price is not: shorter runs mean
      // less tray fill, less weight, and less to re-pull on a change.
      length_only: pinnedGroups > 0 && movableGroups === 0,
    };
  }

  /**
   * What shortening every link would be worth.
   *
   * When the room sits inside one price step, the interesting question stops
   * being "where do the racks go" and becomes "how do I get under the next step
   * at all". Fixed overhead is the answer: a link spends ~5 m climbing to the
   * tray, dropping into the far rack, and coiling a service loop at each end,
   * and every metre of that is a metre unavailable for horizontal reach.
   *
   * So price the current layout again with each link shortened by Δ. The result
   * is exact for this layout -- no relaxation -- and says plainly what a lower
   * tray or a tighter service loop is worth before anyone re-runs the solver.
   */
  function unlockCurve(groups, dist, posOf, slack2, deltas = [0.5, 1.0, 1.5, 2.0, 3.0]) {
    if (!posOf || !groups.length) return [];
    const base = cableCost(groups, dist.D, posOf, slack2);

    return deltas.map((delta) => {
      let usd = 0;
      let reclassed = 0;
      for (const g of groups) {
        const steps = reachSteps(g.speed);
        const here = dist.D[posOf[g.a]][posOf[g.b]] + slack2;
        const there = Math.max(0, here - delta);
        usd += g.count * stepCost(steps, there);
        if (stepKey(steps, there) !== stepKey(steps, here)) reclassed += g.count;
      }
      return {
        delta_m: delta,
        cost_usd: usd,
        saving_usd: base - usd,
        links_reclassed: reclassed,
      };
    }).filter((r) => r.saving_usd > 0);
  }

  DCP.Cost = {
    reachSteps, stepCost, stepKey,
    positionDistances, floorSignature,
    linkGroups, flowGroups,
    cableCost, cableLength, bounds, unlockCurve,
    UNREACH_MULT, UNREACH_PER_M,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
