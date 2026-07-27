/**
 * Rack placement as a Quadratic Assignment Problem.
 *
 *   minimize  Σ_groups  count · price(distance(pos_a, pos_b))
 *           + pull · Σ_groups count · distance(pos_a, pos_b)
 *           + λ    · Σ_flows  demand · distance(pos_a, pos_b)
 *
 * The first term is the bill: media price is a *step* function of length, so the
 * objective is piecewise-constant and the solver has to be told about the steps
 * rather than handed an average. The second is the labour of pulling the cable,
 * which is what keeps a gradient alive inside a flat step -- without it the
 * annealer random-walks across every layout that happens to cost the same. The
 * third is traffic locality, priced in $ per GB/s·m so it can be added to money
 * instead of blended into a dimensionless score.
 *
 * QAP is NP-hard, so this is the usual practical stack: a greedy constructive
 * seed, then metaheuristic refinement, with every candidate move evaluated
 * incrementally against only the groups that touch the racks being moved.
 *
 * The emergent behaviour is the point: give the network rack a big flow term to
 * every compute rack and the solver puts it in the middle of the row on its own,
 * because that is what minimizes the objective. Nobody has to hard-code "middle
 * of row".
 *
 * A spectral seed was tried here and removed. It is the textbook opening move
 * for VLSI placement -- embed the netlist with the Laplacian's second and third
 * eigenvectors, then legalise onto the site grid with an exact linear assignment
 * -- and it lost to plain greedy insertion in all twelve configurations
 * measured, by 1.3% to 38.6%, worst when traffic dominated.
 *
 * The reason is structural rather than a tuning failure. Spectral placement
 * recovers geometry from a netlist that *has* geometry: cells wired to many
 * neighbours, forming a mesh. A leaf-spine fabric homed into two network racks
 * is a star -- in a 52-rack hall, 48 racks had degree 1 and the affinity graph
 * was 4% dense. Every leaf hanging off a hub is structurally interchangeable, so
 * the eigenvectors are degenerate, the embedding gives those 48 racks nearly the
 * same coordinate, and the assignment scatters them arbitrarily. The error grows
 * with rack count, which is exactly the wrong direction.
 *
 * Worth revisiting only if the affinity graph stops being a star -- per-rack
 * leaves with direct rack-to-rack links would qualify.
 */
(function (root) {
  const DCP = (root.DCP = root.DCP || {});

  /**
   * Legacy geometric distance, kept as a fallback for callers with no pathway
   * graph. The real solver uses DCP.Cost.positionDistances, which walks the tray
   * skeleton and is exact rather than approximate.
   */
  function distanceMatrix(positions, crossRowFactor = 1.35) {
    const m = positions.length;
    const D = Array.from({ length: m }, () => new Float64Array(m));
    for (let a = 0; a < m; a++) {
      for (let b = a + 1; b < m; b++) {
        const dx = Math.abs(positions[a].x - positions[b].x);
        const dy = Math.abs(positions[a].y - positions[b].y);
        const d = dx + dy * (positions[a].row === positions[b].row ? 1 : crossRowFactor);
        D[a][b] = d;
        D[b][a] = d;
      }
    }
    return D;
  }

  /* ------------------------------------------------------------ objective -- */

  /**
   * The objective, with incremental deltas.
   *
   * Both terms are sparse: a rack pair only contributes if it carries cable or
   * demand. Evaluating a move therefore costs O(groups touching that rack), not
   * O(racks) -- which is what makes tens of thousands of iterations affordable on
   * a hall with hundreds of racks.
   */
  function makeObjective(problem, lambda, pull) {
    const { n, dist, groups, flows, slack2 } = problem;
    const D = dist.D;
    const Cost = DCP.Cost;

    // Precompute the price ladder per group so the hot loop never re-derives it.
    const gSteps = groups.map((g) => Cost.reachSteps(g.speed));

    // rack → the groups and flows it participates in.
    const gTouch = Array.from({ length: n }, () => []);
    groups.forEach((g, i) => {
      gTouch[g.a].push(i);
      if (g.b !== g.a) gTouch[g.b].push(i);
    });
    const fTouch = Array.from({ length: n }, () => []);
    flows.forEach((f, i) => {
      fTouch[f.a].push(i);
      if (f.b !== f.a) fTouch[f.b].push(i);
    });

    // Stamp array so a group touching both moved racks is scored exactly once.
    const stamp = new Int32Array(groups.length);
    const fstamp = new Int32Array(flows.length);
    let epoch = 0;

    const groupCost = (gi, pa, pb) => {
      const g = groups[gi];
      const d = D[pa][pb] + slack2;
      return g.count * (Cost.stepCost(gSteps[gi], d) + pull * d);
    };

    function total(posOf) {
      let v = 0;
      for (let i = 0; i < groups.length; i++) {
        v += groupCost(i, posOf[groups[i].a], posOf[groups[i].b]);
      }
      if (lambda > 0) {
        for (const f of flows) v += lambda * f.w * D[posOf[f.a]][posOf[f.b]];
      }
      return v;
    }

    /** Native-unit breakdown, for the report. */
    function terms(posOf) {
      let material = 0;
      let length = 0;
      let moment = 0;
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        const d = D[posOf[g.a]][posOf[g.b]] + slack2;
        material += g.count * DCP.Cost.stepCost(gSteps[i], d);
        length += g.count * d;
      }
      for (const f of flows) moment += f.w * D[posOf[f.a]][posOf[f.b]];
      return {
        material_usd: material,
        pull_usd: pull * length,
        length_m: length,
        traffic_moment: moment,
        traffic_usd: lambda * moment,
        objective: material + pull * length + lambda * moment,
      };
    }

    /** Where rack v sits once a and b trade places. */
    const after = (v, a, b, pa, pb, posOf) => (v === a ? pb : v === b ? pa : posOf[v]);

    function swapDelta(posOf, a, b) {
      const pa = posOf[a];
      const pb = posOf[b];
      let d = 0;
      epoch++;

      for (const list of [gTouch[a], gTouch[b]]) {
        for (const gi of list) {
          if (stamp[gi] === epoch) continue;
          stamp[gi] = epoch;
          const g = groups[gi];
          d += groupCost(gi, after(g.a, a, b, pa, pb, posOf), after(g.b, a, b, pa, pb, posOf))
             - groupCost(gi, posOf[g.a], posOf[g.b]);
        }
      }

      if (lambda > 0) {
        for (const list of [fTouch[a], fTouch[b]]) {
          for (const fi of list) {
            if (fstamp[fi] === epoch) continue;
            fstamp[fi] = epoch;
            const f = flows[fi];
            d += lambda * f.w * (D[after(f.a, a, b, pa, pb, posOf)][after(f.b, a, b, pa, pb, posOf)]
                               - D[posOf[f.a]][posOf[f.b]]);
          }
        }
      }
      return d;
    }

    function moveDelta(posOf, a, target) {
      let d = 0;
      for (const gi of gTouch[a]) {
        const g = groups[gi];
        const oa = g.a === a ? target : posOf[g.a];
        const ob = g.b === a ? target : posOf[g.b];
        d += groupCost(gi, oa, ob) - groupCost(gi, posOf[g.a], posOf[g.b]);
      }
      if (lambda > 0) {
        for (const fi of fTouch[a]) {
          const f = flows[fi];
          const oa = f.a === a ? target : posOf[f.a];
          const ob = f.b === a ? target : posOf[f.b];
          d += lambda * f.w * (D[oa][ob] - D[posOf[f.a]][posOf[f.b]]);
        }
      }
      return d;
    }

    return { total, terms, swapDelta, moveDelta, lambda, pull };
  }

  /* ----------------------------------------------------------------- seeds -- */

  function sequentialSeed(n, m) {
    const posOf = new Int32Array(n);
    for (let i = 0; i < n; i++) posOf[i] = Math.min(i, m - 1);
    return posOf;
  }

  /** Symmetric affinity between racks: cable count and demand, each normalised. */
  function affinity(n, groups, flows) {
    const adj = Array.from({ length: n }, () => new Map());
    const bump = (a, b, w) => {
      if (a === b || !(w > 0)) return;
      adj[a].set(b, (adj[a].get(b) || 0) + w);
      adj[b].set(a, (adj[b].get(a) || 0) + w);
    };
    const cTotal = Math.max(1e-9, DCP.Util.sum(groups, (g) => g.count));
    const fTotal = Math.max(1e-9, DCP.Util.sum(flows, (f) => f.w));
    for (const g of groups) bump(g.a, g.b, g.count / cTotal);
    for (const f of flows) bump(f.a, f.b, f.w / fTotal);
    return adj;
  }

  /**
   * Constructive seed: place the busiest rack at the most central position, then
   * repeatedly place whichever unplaced rack talks most to the placed set, at
   * whichever free position minimizes the incremental cost.
   */
  function greedySeed(n, m, D, adj) {
    const posOf = new Int32Array(n).fill(-1);
    const used = new Uint8Array(m);

    const weight = [];
    for (let i = 0; i < n; i++) weight.push({ i, f: DCP.Util.sum([...adj[i].values()]) });
    weight.sort((a, b) => b.f - a.f || a.i - b.i);

    // "Central" = minimum total distance to everywhere else.
    let center = 0;
    let bestCenter = Infinity;
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let l = 0; l < m; l++) s += D[j][l];
      if (s < bestCenter) {
        bestCenter = s;
        center = j;
      }
    }

    const placed = [];
    const first = weight[0].i;
    posOf[first] = center;
    used[center] = 1;
    placed.push(first);

    for (let idx = 1; idx < n; idx++) {
      let pick = -1;
      let pickF = -Infinity;
      for (let i = 0; i < n; i++) {
        if (posOf[i] >= 0) continue;
        let f = 0;
        for (const p of placed) f += adj[i].get(p) || 0;
        if (f > pickF || (f === pickF && (pick < 0 || i < pick))) {
          pickF = f;
          pick = i;
        }
      }
      if (pick < 0) break;

      let bestPos = -1;
      let bestCost = Infinity;
      for (let j = 0; j < m; j++) {
        if (used[j]) continue;
        let c = 0;
        for (const p of placed) c += (adj[pick].get(p) || 0) * D[j][posOf[p]];
        if (c < bestCost) {
          bestCost = c;
          bestPos = j;
        }
      }
      posOf[pick] = bestPos;
      used[bestPos] = 1;
      placed.push(pick);
    }

    for (let i = 0; i < n; i++) {
      if (posOf[i] >= 0) continue;
      for (let j = 0; j < m; j++) {
        if (!used[j]) {
          posOf[i] = j;
          used[j] = 1;
          break;
        }
      }
    }
    return posOf;
  }

  /* ------------------------------------------------------------ refinement -- */

  /**
   * Typical magnitude of a candidate move, sampled without applying any.
   *
   * The temperature schedule needs a scale, and the obvious one -- the objective
   * divided by the rack count -- is wrong here, because most of the objective is
   * usually a constant: media class that no arrangement can change. Scaling
   * against it inflates T by the size of that constant, every uphill move is
   * accepted, and annealing degenerates into a random walk that hands back
   * something worse than the seed it started from. Sampling the moves measures
   * what the schedule actually has to reason about and is immune to any offset.
   */
  function probeScale(obj, posOf, movable, free, rand) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < 128; i++) {
      const a = movable[Math.floor(rand() * movable.length)];
      let d;
      if (free.length && rand() < 0.25) {
        d = obj.moveDelta(posOf, a, free[Math.floor(rand() * free.length)]);
      } else {
        const b = movable[Math.floor(rand() * movable.length)];
        if (a === b) continue;
        d = obj.swapDelta(posOf, a, b);
      }
      sum += Math.abs(d);
      n++;
    }
    return n ? sum / n : 0;
  }

  /**
   * Simulated annealing over swaps and relocations.
   * Geometric cooling; a worse move survives with probability e^(-Δ/T).
   */
  function anneal(obj, posOf, m, opts) {
    const rand = DCP.Util.rng(opts.seed || 7);
    const n = posOf.length;
    if (n < 2) return { posOf, accepted: 0, iters: 0 };

    const used = new Uint8Array(m);
    for (const p of posOf) used[p] = 1;
    const frozen = new Set(opts.frozen || []);

    const movable = [];
    for (let i = 0; i < n; i++) if (!frozen.has(i)) movable.push(i);
    if (movable.length < 2) return { posOf, accepted: 0, iters: 0 };

    const free = [];
    for (let j = 0; j < m; j++) if (!used[j]) free.push(j);

    const iters = opts.iters || 20000;
    const t0 = opts.t0 || 1.0;
    const t1 = opts.t1 || 0.01;
    // Measured from the moves themselves, so the schedule behaves the same for a
    // 4-rack room and a 400-rack hall -- and does not care how much constant
    // money is sitting in the objective alongside them.
    const scale = Math.max(1e-9, probeScale(obj, posOf, movable, free, rand));
    const decay = Math.pow(t1 / t0, 1 / Math.max(1, iters));

    // Annealing wanders on purpose, so the state it happens to stop in is not
    // the state worth keeping. Track the best one seen and return that.
    const best = Int32Array.from(posOf);
    let cur = 0;
    let bestRel = 0;

    let T = t0;
    let accepted = 0;

    for (let it = 0; it < iters; it++) {
      const useMove = free.length > 0 && rand() < 0.25;
      let delta;
      let apply;

      if (useMove) {
        const a = movable[Math.floor(rand() * movable.length)];
        const fi = Math.floor(rand() * free.length);
        const target = free[fi];
        delta = obj.moveDelta(posOf, a, target);
        apply = () => {
          free[fi] = posOf[a];
          posOf[a] = target;
        };
      } else {
        const a = movable[Math.floor(rand() * movable.length)];
        let b = movable[Math.floor(rand() * movable.length)];
        if (a === b) b = movable[(movable.indexOf(a) + 1) % movable.length];
        if (a === b) continue;
        delta = obj.swapDelta(posOf, a, b);
        apply = () => {
          const t = posOf[a];
          posOf[a] = posOf[b];
          posOf[b] = t;
        };
      }

      if (delta <= 0 || rand() < Math.exp(-delta / (T * scale))) {
        apply();
        accepted++;
        cur += delta;
        if (cur < bestRel - 1e-9) {
          bestRel = cur;
          best.set(posOf);
        }
      }
      T *= decay;
    }

    return { posOf: best, accepted, iters, improved: -bestRel };
  }

  /**
   * Order-crossover GA over placement permutations. Offered as an alternative to
   * annealing: it explores more broadly on rooms with many equivalent positions,
   * at the cost of more objective evaluations.
   */
  function genetic(obj, seedPos, m, opts) {
    const rand = DCP.Util.rng((opts.seed || 7) + 991);
    const n = seedPos.length;
    if (n < 3) return { posOf: seedPos, generations: 0 };

    const popSize = opts.population || 40;
    const generations = opts.generations || 120;
    const elite = Math.max(2, Math.floor(popSize * 0.1));

    const freeAll = [];
    {
      const used = new Uint8Array(m);
      for (const p of seedPos) used[p] = 1;
      for (let j = 0; j < m; j++) if (!used[j]) freeAll.push(j);
    }

    const shuffled = () => {
      const p = Int32Array.from(seedPos);
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [p[i], p[j]] = [p[j], p[i]];
      }
      return p;
    };

    let pop = [Int32Array.from(seedPos)];
    for (let i = 1; i < popSize; i++) pop.push(shuffled());

    let best = Int32Array.from(seedPos);
    let bestC = obj.total(best);

    for (let g = 0; g < generations; g++) {
      const scored = pop.map((p) => ({ p, c: obj.total(p) })).sort((a, b) => a.c - b.c);
      if (scored[0].c < bestC) {
        bestC = scored[0].c;
        best = Int32Array.from(scored[0].p);
      }

      const next = scored.slice(0, elite).map((s) => Int32Array.from(s.p));
      const tournament = () => {
        const a = scored[Math.floor(rand() * scored.length)];
        const b = scored[Math.floor(rand() * scored.length)];
        return a.c <= b.c ? a.p : b.p;
      };

      while (next.length < popSize) {
        const pa = tournament();
        const pb = tournament();
        // Order crossover (OX): keep a slice of parent A, fill the rest with
        // parent B's order, skipping positions already taken.
        const i = Math.floor(rand() * n);
        const j = i + Math.floor(rand() * (n - i));
        const child = new Int32Array(n).fill(-1);
        const taken = new Set();
        for (let k = i; k <= j; k++) {
          child[k] = pa[k];
          taken.add(pa[k]);
        }
        let cursor = 0;
        for (let k = 0; k < n; k++) {
          if (child[k] >= 0) continue;
          while (cursor < n && taken.has(pb[cursor])) cursor++;
          child[k] = cursor < n ? pb[cursor++] : -1;
          if (child[k] >= 0) taken.add(child[k]);
        }
        // Repair any hole with an unused position.
        for (let k = 0; k < n; k++) {
          if (child[k] >= 0) continue;
          for (const f of freeAll) {
            if (!taken.has(f)) {
              child[k] = f;
              taken.add(f);
              break;
            }
          }
        }
        if (rand() < 0.3) {
          const a = Math.floor(rand() * n);
          const b = Math.floor(rand() * n);
          const t = child[a];
          child[a] = child[b];
          child[b] = t;
        }
        next.push(child);
      }
      pop = next;
    }

    return { posOf: best, generations };
  }

  /* ----------------------------------------------------------------- entry -- */

  /**
   * @param {object} problem  {n, D, positions, groups, flows, slack2}
   * @param {object} opts     {method, seed, iters, t0, t1, pins, frozen,
   *                           traffic_weight, pull_cost_usd_per_m}
   */
  function place(problem, opts = {}) {
    const { n, dist, positions, groups, flows, slack2 } = problem;
    const D = dist.D;
    const m = positions.length;
    const pull = opts.pull_cost_usd_per_m ?? 0;

    if (n === 0 || m === 0) {
      const empty = makeObjective({ ...problem, n: 0 }, 0, pull);
      return {
        posOf: new Int32Array(0), method: "none", lambda: 0,
        terms: empty.terms(new Int32Array(0)),
        baseline: empty.terms(new Int32Array(0)),
        stats: {},
      };
    }

    const adj = affinity(n, groups, flows);
    const baselinePos = sequentialSeed(n, m);

    /**
     * λ converts traffic moment into money, so the slider still means "spend
     * this share of the objective on locality" while both halves stay in units a
     * network engineer can argue with.
     *
     * Calibrate it against how much each term can *move*, not how big each term
     * is. Most of a cable bill is usually constant -- media class that no
     * arrangement can change -- and normalising against the total lets that
     * constant swamp the slider: λ comes out ~60× too high, the solver optimises
     * locality alone, and cable length runs away by a third while the invoice
     * stays identical. Range against range, a term that cannot move contributes
     * nothing, which is the correct answer.
     */
    const w = DCP.Util.clamp(opts.traffic_weight ?? 0, 0, 0.99);
    let lambda = 0;
    if (w > 0 && flows.length && dist.max_m > dist.min_m) {
      const near = dist.min_m + slack2;
      const far = dist.max_m + slack2;
      let cableRange = 0;
      for (const g of groups) {
        const steps = DCP.Cost.reachSteps(g.speed);
        cableRange += g.count * (DCP.Cost.stepCost(steps, far) - DCP.Cost.stepCost(steps, near)
                               + pull * (far - near));
      }
      const trafficRange = DCP.Util.sum(flows, (f) => f.w) * (dist.max_m - dist.min_m);
      if (trafficRange > 1e-9 && cableRange > 0) {
        lambda = (w / (1 - w)) * (cableRange / trafficRange);
      }
    }

    const obj = makeObjective(problem, lambda, pull);
    const method = opts.method || "anneal";
    let posOf;
    let stats = {};

    if (method === "sequential") {
      posOf = baselinePos;
    } else {
      posOf = greedySeed(n, m, D, adj);
      stats.seed = "greedy";

      if (method === "anneal") {
        const r = anneal(obj, posOf, m, opts);
        posOf = r.posOf;
        stats.accepted = r.accepted;
        stats.iters = r.iters;
      } else if (method === "genetic") {
        const r = genetic(obj, posOf, m, opts);
        posOf = r.posOf;
        // Always polish a GA result with a short anneal -- OX crossover leaves
        // easy pairwise wins on the table.
        const a = anneal(obj, posOf, m, { ...opts, iters: Math.floor((opts.iters || 20000) / 4) });
        posOf = a.posOf;
        stats.generations = r.generations;
        stats.accepted = a.accepted;
      }
    }

    // Honour pinned racks last so a manual override always wins over the solver.
    if (opts.pins) {
      for (const [rackIdx, posIdx] of Object.entries(opts.pins)) {
        const i = Number(rackIdx);
        const target = Number(posIdx);
        const holder = [...posOf].findIndex((p) => p === target);
        if (holder >= 0 && holder !== i) {
          const t = posOf[i];
          posOf[i] = target;
          posOf[holder] = t;
        } else {
          posOf[i] = target;
        }
      }
    }

    return {
      posOf, method, lambda,
      terms: obj.terms(posOf),
      baseline: obj.terms(baselinePos),
      stats,
    };
  }

  DCP.Placement = {
    place, distanceMatrix, makeObjective,
    greedySeed, sequentialSeed, affinity,
    probeScale, anneal, genetic,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
