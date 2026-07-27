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

  /* ------------------------------------------------ utility service cost -- */

  /**
   * What it costs to tie a rack at a given position into the facility.
   *
   * The placement objective used to price *data cable only*. Everything else a
   * rack needs -- a power whip from the RPP column, a supply and return hose
   * from its CDU -- was laid in afterwards, against whatever arrangement the
   * fiber objective happened to produce. That is the "place racks where they
   * fit" failure applied to the utilities: on the default design it is ~770 m of
   * whip and ~200 m of hose, about $83k, that no solver ever looked at.
   *
   * Utilities differ from fiber in a way that matters for the formulation. A
   * fiber link joins two racks, so it is quadratic -- its cost depends on where
   * *both* ends land. A whip joins a rack to whichever panel is nearest, and a
   * hose joins a rack to whichever CDU is nearest. Those are singly-indexed:
   * cost depends only on where *this* rack sits. So they enter the objective as
   * a linear term over a precomputed (rack × position) table, which is both
   * cheaper than the quadratic part and exactly O(1) to re-evaluate on a move.
   *
   * Only the per-metre part is priced. Terminations, the breaker, the pair of
   * quick-disconnects -- every rack pays those wherever it stands, so they are
   * constant across layouts and cannot inform a placement decision. Same
   * discipline as `bounds()`: report what placement can actually move.
   */

  const fieldCache = new Map();
  const FIELD_CACHE_MAX = 6;

  /**
   * Pathway distance from every candidate position to every anchor, on one tier.
   *
   * Anchors are the things a rack has to reach -- RPP panels, CDUs. There are
   * only ever a handful, so this is a Dijkstra per anchor rather than the
   * all-pairs sweep `positionDistances` does, and it runs on the tier the run
   * actually travels: power on the power tier, coolant on the fluid tier. Using
   * the data tier for all three would charge a hose the ceiling height of a
   * fiber tray.
   */
  function anchorField(floor, design, tier, anchors) {
    const m = floor.positions.length;
    const k = anchors.length;
    const A = Array.from({ length: k }, () => new Float64Array(m).fill(Infinity));
    if (!m || !k) return { A, k, m };

    const key = [
      floorSignature(floor, design), tier,
      anchors.map((a) => `${DCP.Util.round(a.x, 2)}:${DCP.Util.round(a.y, 2)}`).join("|"),
    ].join("#");
    if (fieldCache.has(key)) return fieldCache.get(key);

    const height = tier === "power" ? design.room.power_tray_height_m
      : tier === "fluid" ? (design.room.raised_floor ? 0.3 : 0.5)
      : design.room.tray_height_m;
    const runs = tier === "power" ? design.room.power_tray_runs
      : tier === "fluid" ? design.room.fluid_tray_runs
      : design.room.data_tray_runs;

    const g = DCP.Pathways.buildTier(floor, tier, height, runs);
    const posNode = floor.positions.map((p, i) => DCP.Pathways.addDrop(g, `pos:${i}`, p.x, p.y));
    const anchorNode = anchors.map((a, i) => DCP.Pathways.addDrop(g, `anchor:${i}`, a.x, a.y));

    for (let i = 0; i < k; i++) {
      const dist = dijkstra(g, anchorNode[i]);
      for (let j = 0; j < m; j++) A[i][j] = dist[posNode[j]];
    }

    const result = { A, k, m };
    if (fieldCache.size >= FIELD_CACHE_MAX) fieldCache.delete(fieldCache.keys().next().value);
    fieldCache.set(key, result);
    return result;
  }

  /**
   * Per-metre rate for one rack's power whips and coolant hoses.
   *
   * Both scale with what the rack draws, which is the point: a 100 kW rack pulls
   * three whips a side and needs a fatter bore than a 12 kW management rack, so
   * moving the big one costs several times what moving the small one saves. A
   * flat per-rack rate would place them as though they were interchangeable.
   */
  function serviceRates(rack, design, feeds) {
    const C = DCP.Catalog;
    const P = design.power;

    const pduSpec = C.RACK_PDU[P.rack_pdu_model] || C.RACK_PDU["pdu-3ph-60a"];
    // Same derated sizing power.js uses, so the whip count here is the whip
    // count that gets scheduled.
    const pduKw = pduSpec.amps * P.breaker_derate * pduSpec.volts
      * (pduSpec.phases === 3 ? Math.sqrt(3) : 1) / 1000;
    const perSide = Math.max(1, Math.ceil(rack.kw / feeds / Math.max(1e-9, pduKw)));

    // A busway tap drops straight out of the run hanging over its own row, so
    // there is no horizontal whip to shorten and the term correctly goes to
    // zero -- which is the real advantage of busway, now visible to the solver.
    let whipRate = 0;
    if (P.distribution !== "busway") {
      const pick = C.sizePowerMedia(rack.kw / feeds / perSide, P.volts, P.phases, P.breaker_derate);
      const whip = C.POWER_MEDIA[pick.key];
      whipRate = (whip ? whip.cost_usd_per_m || 0 : 0) * perSide * feeds;
    }

    const deltaT = Math.max(1, design.cooling.return_c - design.cooling.supply_c);
    let hoseRate = 0;
    if (design.cooling.mode === "water") {
      const lpm = C.flowLpm(rack.kw, deltaT);
      const hose = C.COOLANT_MEDIA[C.sizeCoolantMedia(lpm, "hose").key];
      // Supply and return: two runs over the same path.
      hoseRate = (hose ? hose.cost_usd_per_m || 0 : 0) * 2;
    }

    return { power_usd_per_m: whipRate, coolant_usd_per_m: hoseRate, pdus_per_side: perSide };
  }

  /**
   * (rack × position) tables of what the utilities cost at each spot.
   *
   * A rack is served by the *nearest* panel and the nearest CDU, which is what
   * power.js and cooling.js go on to do, so the table takes a min over anchors.
   * That ignores panel capacity -- a relaxation, and a deliberate one: the
   * fixed-point pass in build.js recomputes these against gear that has actually
   * been sited under its real capacity rules, so the approximation is corrected
   * rather than believed.
   *
   * `Infinity` survives into the table when a position cannot reach any anchor
   * at all, and `unreachable` counts how often. It is left as Infinity here so
   * the condition stays visible rather than being laundered into a large number
   * that looks like a normal answer; placement.js clamps it to its own finite
   * violation price at the point it folds these into the objective.
   */
  function serviceCosts(spec) {
    const { racks, floor, design, feeds } = spec;
    const n = racks.length;
    const m = floor.positions.length;
    const power = new Float64Array(n * m);
    const coolant = new Float64Array(n * m);
    const out = {
      power, coolant, n, m,
      power_anchors: spec.powerAnchors || [],
      coolant_anchors: spec.coolantAnchors || [],
      unreachable: 0,
    };
    if (!n || !m) return out;

    const pf = (out.power_anchors.length)
      ? anchorField(floor, design, "power", out.power_anchors) : null;
    const cf = (out.coolant_anchors.length)
      ? anchorField(floor, design, "fluid", out.coolant_anchors) : null;

    // Nearest anchor per position, once, rather than per rack -- the rate scales
    // the same distance for every rack, so the argmin is rack-independent.
    const nearestPower = new Float64Array(m).fill(0);
    const nearestCoolant = new Float64Array(m).fill(0);
    for (let j = 0; j < m; j++) {
      let bp = Infinity;
      if (pf) for (let i = 0; i < pf.k; i++) if (pf.A[i][j] < bp) bp = pf.A[i][j];
      let bc = Infinity;
      if (cf) for (let i = 0; i < cf.k; i++) if (cf.A[i][j] < bc) bc = cf.A[i][j];
      nearestPower[j] = pf ? bp : 0;
      nearestCoolant[j] = cf ? bc : 0;
      if (!Number.isFinite(nearestPower[j]) || !Number.isFinite(nearestCoolant[j])) out.unreachable++;
    }

    racks.forEach((rack, i) => {
      const r = serviceRates(rack, design, feeds);
      const base = i * m;
      for (let j = 0; j < m; j++) {
        const dp = nearestPower[j];
        const dc = nearestCoolant[j];
        power[base + j] = Number.isFinite(dp) ? r.power_usd_per_m * dp : Infinity;
        coolant[base + j] = Number.isFinite(dc) ? r.coolant_usd_per_m * dc : Infinity;
      }
    });

    return out;
  }

  /** Anchors for pass one, before any gear has actually been sited. */
  function estimateAnchors(floor, design) {
    const power = [];
    const zone = floor.zones.distribution;
    if (design.power.distribution === "busway") {
      // A busway hangs over its own row, so every row is its own anchor and the
      // horizontal term vanishes -- which is the real advantage of busway and
      // should show up in the objective as such.
      for (const row of floor.rows) power.push({ x: (floor.usable.x0 + floor.usable.x1) / 2, y: row.y });
    } else if (zone) {
      const x = (zone.x0 + zone.x1) / 2;
      for (const row of floor.rows) power.push({ x, y: row.y });
    }

    const coolant = [];
    if (design.cooling.mode === "water" && design.cooling.water_type === "dlc") {
      // In-row CDUs land among the racks they serve; before placement the best
      // guess is one per `racks_per_cdu` worth of row, spread along each row.
      const perRow = Math.max(1, Math.round(floor.slotsPerRow / Math.max(1, design.cooling.racks_per_cdu)));
      for (const row of floor.rows) {
        for (let k = 0; k < perRow; k++) {
          const t = (k + 0.5) / perRow;
          coolant.push({ x: floor.usable.x0 + t * (floor.usable.x1 - floor.usable.x0), y: row.y });
        }
      }
    } else if (design.cooling.mode === "water") {
      // Rear-door and perimeter plant stands against the far wall.
      const x = design.room.width_m - design.room.perimeter_m;
      for (const row of floor.rows) coolant.push({ x, y: row.y });
    }

    return { power, coolant };
  }

  /** Anchors for later passes: where the gear was actually put. */
  function sitedAnchors(cooling, power) {
    return {
      power: (power.distribution || []).map((d) => ({ x: d.x, y: d.y })),
      coolant: (cooling.units || [])
        .filter((u) => u.kind === "cdu" || u.kind === "crah")
        .map((u) => ({ x: u.x, y: u.y })),
    };
  }

  DCP.Cost = {
    reachSteps, stepCost, stepKey,
    positionDistances, floorSignature,
    linkGroups, flowGroups,
    cableCost, cableLength, bounds, unlockCurve,
    anchorField, serviceCosts, serviceRates, estimateAnchors, sitedAnchors,
    UNREACH_MULT, UNREACH_PER_M,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
