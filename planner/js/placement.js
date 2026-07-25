/**
 * Rack placement as a Quadratic Assignment Problem.
 *
 *   minimize  Σ_{i,k} Σ_{j,l}  F_ik · D_jl · X_ij · X_kl
 *
 *   F = traffic between rack i and rack k   (from partition.js)
 *   D = pathway distance between floor position j and position l
 *   X = the placement decision
 *
 * QAP is NP-hard, so this is the usual practical stack: a greedy constructive
 * seed, then metaheuristic refinement (simulated annealing by default, an
 * order-crossover GA as an alternative), with every candidate move evaluated
 * incrementally in O(n) instead of recomputing the O(n²) objective.
 *
 * The emergent behaviour is the point: give the network rack a big flow term to
 * every compute rack and the solver puts it in the middle of the row on its own,
 * because that is what minimizes Σ F·D. Nobody has to hard-code "middle of row".
 */
(function (root) {
  const DCP = (root.DCP = root.DCP || {});

  /**
   * Distances follow tray geometry, not line of sight: cables run along the row
   * and then cross between rows at an aisle, so Manhattan is the right metric.
   * Crossing rows costs more than sliding along one -- cross-aisle ladders are
   * scarcer than in-row runs -- hence `crossRowFactor`.
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

  function cost(F, D, posOf) {
    const n = posOf.length;
    let c = 0;
    for (let i = 0; i < n; i++) {
      for (let k = i + 1; k < n; k++) {
        if (F[i][k] === 0) continue;
        c += F[i][k] * D[posOf[i]][posOf[k]];
      }
    }
    return c;
  }

  /** Δ for exchanging the positions of racks a and b. */
  function swapDelta(F, D, posOf, a, b) {
    const pa = posOf[a];
    const pb = posOf[b];
    let d = 0;
    for (let k = 0; k < posOf.length; k++) {
      if (k === a || k === b) continue;
      const pk = posOf[k];
      d += F[a][k] * (D[pb][pk] - D[pa][pk]);
      d += F[b][k] * (D[pa][pk] - D[pb][pk]);
    }
    return d;
  }

  /** Δ for relocating rack a onto a currently empty position. */
  function moveDelta(F, D, posOf, a, target) {
    const pa = posOf[a];
    let d = 0;
    for (let k = 0; k < posOf.length; k++) {
      if (k === a) continue;
      const pk = posOf[k];
      d += F[a][k] * (D[target][pk] - D[pa][pk]);
    }
    return d;
  }

  /**
   * Constructive seed: place the busiest rack at the most central position, then
   * repeatedly place whichever unplaced rack talks most to the placed set, at
   * whichever free position minimizes the incremental cost.
   */
  function greedySeed(F, D, n, positions) {
    const m = positions.length;
    const posOf = new Int32Array(n).fill(-1);
    const used = new Uint8Array(m);

    const flowTotal = [];
    for (let i = 0; i < n; i++) flowTotal.push({ i, f: DCP.Util.sum([...F[i]]) });
    flowTotal.sort((a, b) => b.f - a.f || a.i - b.i);

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
    const first = flowTotal[0].i;
    posOf[first] = center;
    used[center] = 1;
    placed.push(first);

    for (let idx = 1; idx < n; idx++) {
      let pick = -1;
      let pickF = -Infinity;
      for (let i = 0; i < n; i++) {
        if (posOf[i] >= 0) continue;
        let f = 0;
        for (const p of placed) f += F[i][p];
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
        for (const p of placed) c += F[pick][p] * D[j][posOf[p]];
        if (c < bestCost) {
          bestCost = c;
          bestPos = j;
        }
      }
      posOf[pick] = bestPos;
      used[bestPos] = 1;
      placed.push(pick);
    }

    return posOf;
  }

  function sequentialSeed(n, m) {
    const posOf = new Int32Array(n);
    for (let i = 0; i < n; i++) posOf[i] = Math.min(i, m - 1);
    return posOf;
  }

  /**
   * Simulated annealing over swaps and relocations.
   * Geometric cooling; a worse move survives with probability e^(-Δ/T).
   */
  function anneal(F, D, posOf, m, opts) {
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
    // Normalize temperature against the objective's own scale so the schedule
    // behaves the same for a 4-rack room and a 400-rack hall.
    const scale = Math.max(1e-9, cost(F, D, posOf) / Math.max(1, n));
    const decay = Math.pow(t1 / t0, 1 / Math.max(1, iters));

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
        delta = moveDelta(F, D, posOf, a, target);
        apply = () => {
          free[fi] = posOf[a];
          posOf[a] = target;
        };
      } else {
        const a = movable[Math.floor(rand() * movable.length)];
        let b = movable[Math.floor(rand() * movable.length)];
        if (a === b) b = movable[(movable.indexOf(a) + 1) % movable.length];
        if (a === b) continue;
        delta = swapDelta(F, D, posOf, a, b);
        apply = () => {
          const t = posOf[a];
          posOf[a] = posOf[b];
          posOf[b] = t;
        };
      }

      if (delta <= 0 || rand() < Math.exp(-delta / (T * scale))) {
        apply();
        accepted++;
      }
      T *= decay;
    }

    return { posOf, accepted, iters };
  }

  /**
   * Order-crossover GA over placement permutations. Offered as an alternative to
   * annealing: it explores more broadly on rooms with many equivalent positions,
   * at the cost of more objective evaluations.
   */
  function genetic(F, D, seedPos, m, opts) {
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

    const fitness = (p) => cost(F, D, p);
    let best = Int32Array.from(seedPos);
    let bestC = fitness(best);

    for (let g = 0; g < generations; g++) {
      const scored = pop.map((p) => ({ p, c: fitness(p) })).sort((a, b) => a.c - b.c);
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

  /**
   * @returns {{posOf:Int32Array, cost:number, baseline:number, method:string, stats:object}}
   */
  function place(F, positions, opts = {}) {
    const n = F.length;
    const m = positions.length;
    const D = distanceMatrix(positions, opts.crossRowFactor);
    if (n === 0) return { posOf: new Int32Array(0), cost: 0, baseline: 0, method: "none", D, stats: {} };

    const baselinePos = sequentialSeed(n, m);
    const baseline = cost(F, D, baselinePos);

    const method = opts.method || "anneal";
    let posOf;
    let stats = {};

    if (method === "sequential") {
      posOf = baselinePos;
    } else {
      posOf = greedySeed(F, D, n, positions);
      if (method === "anneal") {
        const r = anneal(F, D, posOf, m, opts);
        posOf = r.posOf;
        stats = { accepted: r.accepted, iters: r.iters };
      } else if (method === "genetic") {
        const r = genetic(F, D, posOf, m, opts);
        posOf = r.posOf;
        // Always polish a GA result with a short anneal -- OX crossover leaves
        // easy pairwise wins on the table.
        const a = anneal(F, D, posOf, m, { ...opts, iters: Math.floor((opts.iters || 20000) / 4) });
        posOf = a.posOf;
        stats = { generations: r.generations, accepted: a.accepted };
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
      posOf, D, method,
      cost: cost(F, D, posOf),
      baseline,
      stats,
    };
  }

  DCP.Placement = { place, distanceMatrix, cost, swapDelta, moveDelta, greedySeed, anneal, genetic };
})(typeof globalThis !== "undefined" ? globalThis : this);
