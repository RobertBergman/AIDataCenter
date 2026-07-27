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
   * What standing somewhere a hard rule forbids costs the objective.
   *
   * Far above any real layout decision -- no arrangement of cable is worth a
   * rack in the wrong pod -- but finite, so a solve that begins in violation can
   * still be led out of it one move at a time.
   */
  const INFEASIBLE_USD = 5e6;

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
   * Three shapes of term, and the shape is what decides how each is evaluated:
   *
   *   quadratic -- fiber and traffic. Cost depends on where *both* ends of a
   *                relationship land. Sparse, so a move costs O(groups touching
   *                that rack) rather than O(racks).
   *
   *   linear    -- power whips, coolant hoses, walk-to-the-door, growth reserve.
   *                Each depends only on where *this* rack sits, so they collapse
   *                into one precomputed (rack × position) table and a move costs
   *                exactly two lookups.
   *
   *   aggregate -- distributed floor load. Not a property of any single rack:
   *                it is the total weight standing in a structural bay. Kept as
   *                a running per-bay total so a move still only touches the two
   *                bays involved.
   *
   * Everything is in dollars, so the weights multiply real money: 1.0 means
   * "charge this at face value", and anything else is a deliberate statement
   * that the design cares about it more or less than the invoice says.
   */
  function makeObjective(problem, lambda, pull) {
    const { n, dist, groups, flows, slack2 } = problem;
    const D = dist.D;
    const Cost = DCP.Cost;
    const m = dist.m || (problem.positions ? problem.positions.length : 0);

    /* -------------------------------------------------------- linear -- */
    // Folded into one table up front: the hot loop should not be adding four
    // weighted arrays together on every candidate move.
    const W = problem.weights || {};
    const svc = problem.service;
    const con = problem.constraints;
    const parts = [];
    if (svc) {
      parts.push([W.power ?? 1, svc.power], [W.coolant ?? 1, svc.coolant]);
    }
    if (con) {
      parts.push([W.maintenance ?? 1, con.maintenance], [W.expansion ?? 1, con.expansion]);
    }
    const masked = con && con.mask;
    let L = null;
    if ((parts.length || masked) && n && m) {
      L = new Float64Array(n * m);
      for (const [w, arr] of parts) {
        if (!w || !arr) continue;
        for (let k = 0; k < L.length; k++) L[k] += w * arr[k];
      }
      // A position that reaches no panel or no CDU comes back as Infinity. Left
      // in, the very first delta subtracts one from another and yields NaN,
      // which compares false against everything and turns the annealer into a
      // machine that rejects every move without saying why. Clamp to the same
      // finite wall a hard violation gets: unbuildable, but still a number.
      for (let k = 0; k < L.length; k++) {
        if (!Number.isFinite(L[k])) L[k] = INFEASIBLE_USD;
      }
      // A hard rule is enforced twice, on purpose. `allows` stops the annealer
      // proposing an illegal move at all, which is the cheap path; the price
      // below is what makes an illegal cell *score* badly, which is what the GA
      // needs -- crossover recombines permutations wholesale and cannot be
      // talked out of producing one. Finite, so a design that starts in
      // violation still has a gradient pointing out of it.
      if (masked) {
        for (let k = 0; k < L.length; k++) if (!con.mask[k]) L[k] += INFEASIBLE_USD;
      }
    }
    const lin = L ? (i, j) => L[i * m + j] : () => 0;

    /* ----------------------------------------------------- aggregate -- */
    const bays = con && con.bays;
    const wStruct = W.structural ?? 1;
    const overRate = con ? con.overload_usd_per_kg * wStruct : 0;
    const bayLoad = bays ? new Float64Array(bays.count) : null;
    const bayCap = bays ? bays.capacity_kg : 0;
    const over = (load) => (load > bayCap ? (load - bayCap) * overRate : 0);

    function resetBays(posOf) {
      if (!bayLoad) return;
      bayLoad.fill(0);
      for (let i = 0; i < n; i++) bayLoad[bays.of[posOf[i]]] += con.weight[i];
    }

    function bayTotal() {
      if (!bayLoad) return 0;
      let v = 0;
      for (let b = 0; b < bayLoad.length; b++) v += over(bayLoad[b]);
      return v;
    }

    /**
     * Change in overload cost from shifting `w` kg out of bay `from` into `to`.
     * Same bay is a no-op, which matters -- most moves inside a row stay put.
     */
    function bayShift(from, to, w) {
      if (!bayLoad || from === to || w === 0) return 0;
      return over(bayLoad[from] - w) - over(bayLoad[from])
           + over(bayLoad[to] + w) - over(bayLoad[to]);
    }

    function bayApply(from, to, w) {
      if (!bayLoad || from === to || w === 0) return;
      bayLoad[from] -= w;
      bayLoad[to] += w;
    }

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

    /**
     * Full objective from scratch. Also re-seeds the running bay totals, so any
     * caller that evaluates an arbitrary permutation (the GA does) leaves the
     * incremental state consistent with what it just scored.
     */
    function total(posOf) {
      let v = 0;
      for (let i = 0; i < groups.length; i++) {
        v += groupCost(i, posOf[groups[i].a], posOf[groups[i].b]);
      }
      if (lambda > 0) {
        for (const f of flows) v += lambda * f.w * D[posOf[f.a]][posOf[f.b]];
      }
      for (let i = 0; i < n; i++) v += lin(i, posOf[i]);
      resetBays(posOf);
      return v + bayTotal();
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

      // Reported unweighted, in the units each term is actually bought in. The
      // weights are a statement of priority, not an estimate of price, so a
      // report that folded them in would be quoting a number no supplier will
      // honour.
      let power = 0;
      let coolant = 0;
      let maintenance = 0;
      let expansion = 0;
      for (let i = 0; i < n; i++) {
        const j = posOf[i];
        if (svc) {
          power += svc.power[i * m + j];
          coolant += svc.coolant[i * m + j];
        }
        if (con) {
          maintenance += con.maintenance[i * m + j];
          expansion += con.expansion[i * m + j];
        }
      }
      resetBays(posOf);
      const structural = bayTotal();

      return {
        material_usd: material,
        pull_usd: pull * length,
        length_m: length,
        traffic_moment: moment,
        traffic_usd: lambda * moment,
        power_usd: Number.isFinite(power) ? power : 0,
        coolant_usd: Number.isFinite(coolant) ? coolant : 0,
        maintenance_usd: maintenance,
        expansion_usd: expansion,
        structural_usd: structural,
        objective: material + pull * length + lambda * moment
          + (Number.isFinite(power) ? power : 0) + (Number.isFinite(coolant) ? coolant : 0)
          + maintenance + expansion + structural,
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

      d += lin(a, pb) - lin(a, pa) + lin(b, pa) - lin(b, pb);

      // A swap moves both racks at once, so the two bay shifts have to be scored
      // against the same starting state -- applying one and then measuring the
      // other would double-count whenever both racks share a bay.
      if (bayLoad) {
        const ba = bays.of[pa];
        const bb = bays.of[pb];
        if (ba !== bb) {
          const wa = con.weight[a];
          const wb = con.weight[b];
          const before = over(bayLoad[ba]) + over(bayLoad[bb]);
          const after2 = over(bayLoad[ba] - wa + wb) + over(bayLoad[bb] - wb + wa);
          d += after2 - before;
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
      d += lin(a, target) - lin(a, posOf[a]);
      if (bayLoad) d += bayShift(bays.of[posOf[a]], bays.of[target], con.weight[a]);
      return d;
    }

    /* --------------------------------------------------------- commits -- */
    // The search applies a move by mutating posOf; the running bay totals have
    // to be told, because they are the one piece of state that cannot be read
    // back out of the permutation cheaply.
    function commitMove(a, from, to) {
      if (bayLoad) bayApply(bays.of[from], bays.of[to], con.weight[a]);
    }

    function commitSwap(a, b, pa, pb) {
      if (!bayLoad) return;
      const ba = bays.of[pa];
      const bb = bays.of[pb];
      if (ba === bb) return;
      bayLoad[ba] += con.weight[b] - con.weight[a];
      bayLoad[bb] += con.weight[a] - con.weight[b];
    }

    /** Is rack `i` allowed to stand at position `j`? */
    const allows = con && con.mask
      ? (i, j) => con.mask[i * m + j] === 1
      : () => true;

    return {
      total, terms, swapDelta, moveDelta, commitMove, commitSwap,
      reset: resetBays, allows, linAt: lin, lambda, pull,
    };
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
  function greedySeed(n, m, D, adj, obj) {
    const posOf = new Int32Array(n).fill(-1);
    const used = new Uint8Array(m);
    // A seed that ignores the hard rules hands the annealer a layout it has to
    // spend its early, hottest iterations digging out of. Cheaper to start legal.
    const allows = obj && obj.allows ? obj.allows : () => true;
    const linAt = obj && obj.linAt ? obj.linAt : () => 0;

    const weight = [];
    for (let i = 0; i < n; i++) weight.push({ i, f: DCP.Util.sum([...adj[i].values()]) });
    weight.sort((a, b) => b.f - a.f || a.i - b.i);

    // "Central" = minimum total distance to everywhere else, among the positions
    // the busiest rack is actually allowed to occupy.
    const first = weight[0].i;
    let center = -1;
    let bestCenter = Infinity;
    for (let j = 0; j < m; j++) {
      if (!allows(first, j)) continue;
      let s = linAt(first, j);
      for (let l = 0; l < m; l++) s += D[j][l];
      if (s < bestCenter) {
        bestCenter = s;
        center = j;
      }
    }
    if (center < 0) center = 0;

    const placed = [];
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
        if (used[j] || !allows(pick, j)) continue;
        // Affinity to what is already down, plus what the utilities cost here.
        // Without the second half the seed places purely for fiber and hands the
        // annealer a layout whose whips and hoses all have to be unpicked.
        let c = linAt(pick, j);
        for (const p of placed) c += (adj[pick].get(p) || 0) * D[j][posOf[p]];
        if (c < bestCost) {
          bestCost = c;
          bestPos = j;
        }
      }
      // Nothing legal left: take the cheapest illegal spot rather than stalling.
      // The mask is priced into the objective too, so refinement can still fix it.
      if (bestPos < 0) {
        for (let j = 0; j < m; j++) {
          if (used[j]) continue;
          const c = linAt(pick, j);
          if (c < bestCost) {
            bestCost = c;
            bestPos = j;
          }
        }
      }
      if (bestPos < 0) break;
      posOf[pick] = bestPos;
      used[bestPos] = 1;
      placed.push(pick);
    }

    for (let i = 0; i < n; i++) {
      if (posOf[i] >= 0) continue;
      let fallback = -1;
      for (let j = 0; j < m; j++) {
        if (used[j]) continue;
        if (fallback < 0) fallback = j;
        if (allows(i, j)) {
          fallback = j;
          break;
        }
      }
      if (fallback < 0) break;
      posOf[i] = fallback;
      used[fallback] = 1;
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
    for (let i = 0; i < 256 && n < 128; i++) {
      const a = movable[Math.floor(rand() * movable.length)];
      let d;
      if (free.length && rand() < 0.25) {
        const target = free[Math.floor(rand() * free.length)];
        // Sample only from moves the search would actually make. A constraint
        // violation is priced in the millions to keep the annealer off it, and
        // letting one into the scale would set T against a number no accepted
        // move ever approaches -- the same failure the docstring above describes
        // for constant media cost, an order of magnitude worse.
        if (!obj.allows(a, target)) continue;
        d = obj.moveDelta(posOf, a, target);
      } else {
        const b = movable[Math.floor(rand() * movable.length)];
        if (a === b) continue;
        if (!obj.allows(a, posOf[b]) || !obj.allows(b, posOf[a])) continue;
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

    // The running per-bay totals are state, and the caller may have handed us a
    // permutation the objective has never seen (a GA result, a previous pass).
    obj.reset(posOf);

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
        // Skip rather than score: a proposal the rules forbid is not a candidate,
        // and evaluating it only to reject it wastes the iteration budget.
        if (!obj.allows(a, target)) continue;
        delta = obj.moveDelta(posOf, a, target);
        apply = () => {
          const from = posOf[a];
          free[fi] = from;
          posOf[a] = target;
          obj.commitMove(a, from, target);
        };
      } else {
        const a = movable[Math.floor(rand() * movable.length)];
        let b = movable[Math.floor(rand() * movable.length)];
        if (a === b) b = movable[(movable.indexOf(a) + 1) % movable.length];
        if (a === b) continue;
        // Both halves of a swap have to be legal in their new home.
        if (!obj.allows(a, posOf[b]) || !obj.allows(b, posOf[a])) continue;
        delta = obj.swapDelta(posOf, a, b);
        apply = () => {
          const pa = posOf[a];
          const pb = posOf[b];
          posOf[a] = pb;
          posOf[b] = pa;
          obj.commitSwap(a, b, pa, pb);
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
   * @param {object} problem  {n, dist, positions, groups, flows, slack2,
   *                           service, constraints, weights}
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
      posOf = greedySeed(n, m, D, adj, obj);
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

    // Pinning happens after the solve and overrides it, so it is the one way a
    // finished layout can still sit on an illegal cell. Count them here rather
    // than trusting the search, which by then is not the last word.
    let violations = 0;
    for (let i = 0; i < n; i++) if (!obj.allows(i, posOf[i])) violations++;

    return {
      posOf, method, lambda, violations,
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
