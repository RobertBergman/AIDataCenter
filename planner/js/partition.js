/**
 * Multilevel graph partitioning -- decides which server goes in which rack.
 *
 * This is the METIS/KaHIP recipe, implemented small:
 *
 *   coarsen (heavy-edge matching)
 *        → initial partition (greedy graph growing, capacity-aware)
 *        → uncoarsen, refining with Fiduccia-Mattheyses at every level
 *
 * Objective: minimize the edge cut, i.e. the GB/s of demand that has to leave a
 * rack. Cut traffic is exactly the traffic that must cross the leaf tier, so a
 * lower cut means fewer optics, shorter cables, and fewer hops for NCCL.
 *
 * Constraint: every part (rack) has a hard capacity in server slots. Because the
 * fleet usually fills the racks exactly, there is rarely any slack to move a
 * vertex into -- so refinement uses KL-style *swaps* as well as FM moves, and
 * keeps FM's best-prefix rollback so a pass can climb out of a local minimum.
 */
(function (root) {
  const DCP = (root.DCP = root.DCP || {});

  const MAX_PASSES = 8;

  /** Adjacency for a level: adj[v] = [{to, w}], vwgt[v] = merged server count. */
  function buildLevel(n, edges) {
    const adj = Array.from({ length: n }, () => []);
    for (const e of edges) {
      adj[e.a].push({ to: e.b, w: e.w });
      adj[e.b].push({ to: e.a, w: e.w });
    }
    return adj;
  }

  /**
   * Heavy-edge matching: collapse each vertex with its heaviest free neighbour.
   *
   * `maxVwgt` caps how heavy a merged vertex may become, which is not a tuning
   * knob but a correctness requirement. Coarsening is a bin-packing granularity
   * decision: once a coarse vertex is heavier than the slack left in any rack,
   * it can no longer be placed anywhere, and the initial partition has to dump
   * it somewhere illegal. Eight NVL72 racks used to coarsen 144 trays into
   * vertices of 8 against a cap of 18 -- two fit per rack, sixteen of the
   * eighteen coarse vertices placed, and the last two landed on rack 0 because
   * nothing else had room for them.
   */
  function coarsen(n, adj, vwgt, rand, maxVwgt = Infinity) {
    const match = new Int32Array(n).fill(-1);
    const order = [...Array(n).keys()];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    let cn = 0;
    const map = new Int32Array(n).fill(-1);
    for (const v of order) {
      if (map[v] >= 0) continue;
      let best = -1;
      let bestW = -1;
      for (const { to, w } of adj[v]) {
        if (map[to] >= 0) continue;
        if (vwgt[v] + vwgt[to] > maxVwgt) continue;
        // Prefer the heaviest edge; tie-break on the lighter vertex to keep
        // merged weights even (an unbalanced coarse graph partitions badly).
        if (w > bestW || (w === bestW && best >= 0 && vwgt[to] < vwgt[best])) {
          bestW = w;
          best = to;
        }
      }
      const c = cn++;
      map[v] = c;
      if (best >= 0) {
        map[best] = c;
        match[v] = best;
        match[best] = v;
      }
    }

    const cvwgt = new Float64Array(cn);
    for (let v = 0; v < n; v++) cvwgt[map[v]] += vwgt[v];

    const acc = new Map();
    for (let v = 0; v < n; v++) {
      for (const { to, w } of adj[v]) {
        const a = map[v];
        const b = map[to];
        if (a === b || a > b) continue; // each undirected edge once
        const k = a * cn + b;
        acc.set(k, (acc.get(k) || 0) + w);
      }
    }
    const cedges = [...acc.entries()].map(([k, w]) => ({ a: Math.floor(k / cn), b: k % cn, w }));

    return { n: cn, map, vwgt: cvwgt, edges: cedges, adj: buildLevel(cn, cedges) };
  }

  /**
   * Greedy graph growing: seed each part with the heaviest unassigned vertex,
   * then pull in whichever frontier vertex has the strongest tie to the part.
   */
  function initialPartition(n, adj, vwgt, caps) {
    const P = caps.length;
    const part = new Int32Array(n).fill(-1);
    const load = new Float64Array(P);
    const remaining = new Set([...Array(n).keys()]);

    // Heaviest-first seeding keeps big merged blobs from being split late.
    const byWeight = [...Array(n).keys()].sort((a, b) => vwgt[b] - vwgt[a] || a - b);

    for (let p = 0; p < P; p++) {
      let seed = -1;
      for (const v of byWeight) {
        if (remaining.has(v) && vwgt[v] <= caps[p]) {
          seed = v;
          break;
        }
      }
      if (seed < 0) continue;

      part[seed] = p;
      load[p] += vwgt[seed];
      remaining.delete(seed);

      const gain = new Map();
      const bump = (v) => {
        for (const { to, w } of adj[v]) {
          if (!remaining.has(to)) continue;
          gain.set(to, (gain.get(to) || 0) + w);
        }
      };
      bump(seed);

      for (;;) {
        let best = -1;
        let bestG = -Infinity;
        for (const [v, g] of gain) {
          if (!remaining.has(v)) continue;
          if (load[p] + vwgt[v] > caps[p]) continue;
          if (g > bestG || (g === bestG && v < best)) {
            bestG = g;
            best = v;
          }
        }
        if (best < 0) break;
        part[best] = p;
        load[p] += vwgt[best];
        remaining.delete(best);
        gain.delete(best);
        bump(best);
      }
    }

    // Anything the frontier never reached (disconnected background vertices)
    // goes to the emptiest part that still fits it.
    for (const v of [...remaining]) {
      let best = -1;
      for (let p = 0; p < P; p++) {
        if (load[p] + vwgt[v] > caps[p]) continue;
        if (best < 0 || load[p] < load[best]) best = p;
      }
      // Genuinely nowhere to put it. Take the part that ends up least over its
      // cap rather than always part 0 -- dumping every homeless vertex on the
      // same rack turned a design that was a few slots short overall into one
      // rack at 178% and the rest under-filled. `rebalance` gets a chance at it
      // afterwards, and validate.js reports whatever survives.
      if (best < 0) {
        best = 0;
        for (let p = 1; p < P; p++) {
          if (load[p] - caps[p] < load[best] - caps[best]) best = p;
        }
      }
      part[v] = best;
      load[best] += vwgt[v];
      remaining.delete(v);
    }

    return { part, load };
  }

  /** conn[v*P + p] = total edge weight from v into part p. */
  function buildConn(n, P, adj, part) {
    const conn = new Float64Array(n * P);
    for (let v = 0; v < n; v++) {
      for (const { to, w } of adj[v]) conn[v * P + part[to]] += w;
    }
    return conn;
  }

  function edgeWeight(adj, v, u) {
    for (const { to, w } of adj[v]) if (to === u) return w;
    return 0;
  }

  /**
   * Empty out any part standing over its capacity.
   *
   * FM cannot do this itself, and not by oversight: it selects moves by *gain*,
   * and its feasibility guards only ever ask whether the destination has room.
   * A part that is already over its cap is not a state FM is trying to leave, so
   * an overloaded rack survives refinement untouched whenever draining it would
   * cost cut -- which it essentially always does, because the vertices sitting
   * on that rack are there precisely because they talk to each other.
   *
   * Repair therefore has to be its own objective. Take the most overloaded part,
   * evict whichever vertex is cheapest to lose (highest gain, usually least
   * negative), and repeat. Every eviction strictly reduces total overload, so
   * this terminates; when nothing can move the design really is short of slots
   * and validate.js says so.
   */
  function rebalance(n, adj, vwgt, part, load, caps, conn, applyMove) {
    const P = caps.length;
    let moved = 0;

    for (let guard = 0; guard <= n; guard++) {
      let src = -1;
      let worst = 1e-9;
      for (let p = 0; p < P; p++) {
        if (load[p] - caps[p] > worst) {
          worst = load[p] - caps[p];
          src = p;
        }
      }
      if (src < 0) break;

      let best = null;
      for (let v = 0; v < n; v++) {
        if (part[v] !== src) continue;
        for (let t = 0; t < P; t++) {
          if (t === src || load[t] + vwgt[v] > caps[t]) continue;
          const g = conn[v * P + t] - conn[v * P + src];
          // Tie-break on the heaviest vertex, then on index: clearing the
          // overload in fewer moves disturbs the layout less, and the index
          // keeps the whole thing deterministic.
          if (!best || g > best.g
              || (g === best.g && vwgt[v] > vwgt[best.v])) {
            best = { v, t, g };
          }
        }
      }
      if (!best) break;

      applyMove(best.v, src, best.t);
      moved++;
    }
    return moved;
  }

  /**
   * FM refinement with best-prefix rollback.
   *
   * Each pass builds a sequence of tentative moves/swaps, always taking the
   * highest-gain feasible one among unlocked boundary vertices -- including
   * negative-gain ones, which is what lets it escape local minima -- then
   * rewinds to the prefix with the best cumulative gain.
   *
   * Capacity repair runs first. FM's own guards never create an overload, but
   * they never clear an inherited one either, and every uncoarsening level
   * inherits whatever the level above could not place.
   */
  function fmRefine(n, adj, vwgt, part, load, caps) {
    const P = caps.length;
    let conn = buildConn(n, P, adj, part);
    let totalGain = 0;

    {
      const apply = (v, from, to) => {
        part[v] = to;
        load[from] -= vwgt[v];
        load[to] += vwgt[v];
        for (const { to: u, w } of adj[v]) {
          conn[u * P + from] -= w;
          conn[u * P + to] += w;
        }
      };
      rebalance(n, adj, vwgt, part, load, caps, conn, apply);
    }

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const locked = new Uint8Array(n);
      const history = [];
      let cum = 0;
      let bestCum = 0;
      let bestAt = 0;

      const boundary = () => {
        const out = [];
        for (let v = 0; v < n; v++) {
          if (locked[v]) continue;
          const p = part[v];
          for (let t = 0; t < P; t++) {
            if (t !== p && conn[v * P + t] > 0) {
              out.push(v);
              break;
            }
          }
        }
        return out;
      };

      const applyMove = (v, from, to) => {
        part[v] = to;
        load[from] -= vwgt[v];
        load[to] += vwgt[v];
        for (const { to: u, w } of adj[v]) {
          conn[u * P + from] -= w;
          conn[u * P + to] += w;
        }
      };

      for (let step = 0; step < n; step++) {
        const cand = boundary();
        if (cand.length === 0) break;

        let best = null;
        for (const v of cand) {
          const p = part[v];
          for (let t = 0; t < P; t++) {
            if (t === p) continue;
            if (conn[v * P + t] === 0) continue;
            const gv = conn[v * P + t] - conn[v * P + p];

            if (load[t] + vwgt[v] <= caps[t]) {
              if (!best || gv > best.gain) best = { kind: "move", v, from: p, to: t, gain: gv };
              continue;
            }
            // No slack: look for a partner in t to swap with (KL step).
            for (let u = 0; u < n; u++) {
              if (locked[u] || part[u] !== t) continue;
              if (load[p] - vwgt[v] + vwgt[u] > caps[p]) continue;
              if (load[t] - vwgt[u] + vwgt[v] > caps[t]) continue;
              const gu = conn[u * P + p] - conn[u * P + t];
              const g = gv + gu - 2 * edgeWeight(adj, v, u);
              if (!best || g > best.gain) best = { kind: "swap", v, u, from: p, to: t, gain: g };
            }
          }
        }

        if (!best) break;

        if (best.kind === "move") {
          applyMove(best.v, best.from, best.to);
          locked[best.v] = 1;
          history.push({ kind: "move", v: best.v, from: best.from, to: best.to });
        } else {
          applyMove(best.v, best.from, best.to);
          applyMove(best.u, best.to, best.from);
          locked[best.v] = 1;
          locked[best.u] = 1;
          history.push({ kind: "swap", v: best.v, u: best.u, from: best.from, to: best.to });
        }

        cum += best.gain;
        if (cum > bestCum) {
          bestCum = cum;
          bestAt = history.length;
        }
      }

      // Rewind everything after the best prefix.
      for (let i = history.length - 1; i >= bestAt; i--) {
        const h = history[i];
        if (h.kind === "move") {
          applyMove(h.v, h.to, h.from);
        } else {
          applyMove(h.u, h.from, h.to);
          applyMove(h.v, h.to, h.from);
        }
      }

      totalGain += bestCum;
      if (bestCum <= 1e-9) break;
      conn = buildConn(n, P, adj, part); // resync after rollback
    }

    return totalGain;
  }

  function cutOf(edges, part) {
    let cut = 0;
    for (const e of edges) if (part[e.a] !== part[e.b]) cut += e.w;
    return cut;
  }

  /**
   * @param {number} n            vertex count (job-rank servers)
   * @param {Array}  edges        [{a,b,w}] demand edges over those vertices
   * @param {Array}  caps         per-rack slot capacity
   * @param {object} opts         { seed, coarsen }
   * @returns {{part:Int32Array, cut:number, baselineCut:number, levels:number}}
   */
  function partition(n, edges, caps, opts = {}) {
    const rand = DCP.Util.rng(opts.seed || 1);
    const P = caps.length;
    if (n === 0 || P === 0) return { part: new Int32Array(n), cut: 0, baselineCut: 0, levels: 0 };

    // Baseline for the report: naive round-robin fill, rack by rack.
    const naive = new Int32Array(n);
    {
      let p = 0;
      let used = 0;
      for (let v = 0; v < n; v++) {
        while (p < P - 1 && used >= caps[p]) {
          p++;
          used = 0;
        }
        naive[v] = p;
        used++;
      }
    }
    const baselineCut = cutOf(edges, naive);
    // Naive fill is only a legal answer if it actually respects capacity: the
    // loop above lets the final part absorb the remainder, which overflows when
    // the fleet is bigger than the racks.
    const naiveLegal = (() => {
      const load = new Float64Array(P);
      for (let v = 0; v < n; v++) load[naive[v]]++;
      for (let p = 0; p < P; p++) if (load[p] > caps[p]) return false;
      return true;
    })();

    /**
     * Never hand back something worse than the baseline we measure against.
     *
     * KL/FM is a local-search heuristic and there is no guarantee it beats a
     * trivial fill -- and one workload where it reliably does not is a large
     * data-parallel ring, because a ring's optimal cut *is* contiguous blocks,
     * which is precisely what filling rack by rack produces. Refining from a
     * graph-growing seed then wanders away from an arrangement it cannot
     * recognise as already good.
     *
     * Taking the better of the two costs one comparison and removes the
     * possibility of the optimiser being an active liability.
     */
    const bestOf = (part, cut, levels) => {
      if (naiveLegal && baselineCut < cut - 1e-9) {
        return { part: naive, cut: baselineCut, baselineCut, levels, fell_back: true };
      }
      return { part, cut, baselineCut, levels, fell_back: false };
    };

    if (opts.coarsen === false || n <= P * 4) {
      const adj = buildLevel(n, edges);
      const vwgt = new Float64Array(n).fill(1);
      const { part, load } = initialPartition(n, adj, vwgt, caps);
      fmRefine(n, adj, vwgt, part, load, caps);
      return bestOf(part, cutOf(edges, part), 1);
    }

    // --- coarsen ---------------------------------------------------------
    // Keep coarse vertices small enough to still pack. A quarter of the tightest
    // rack is the usual rule of thumb: fine enough that the remainder after
    // filling a rack can always go somewhere, coarse enough that the multilevel
    // scheme still buys anything.
    const maxVwgt = Math.max(1, Math.floor(Math.min(...caps) / 4));

    const levels = [];
    let cur = { n, edges, adj: buildLevel(n, edges), vwgt: new Float64Array(n).fill(1) };
    while (cur.n > P * 4 && levels.length < 20) {
      const next = coarsen(cur.n, cur.adj, cur.vwgt, rand, maxVwgt);
      if (next.n >= cur.n * 0.95) break; // matching stalled
      levels.push({ fine: cur, map: next.map });
      cur = { n: next.n, edges: next.edges, adj: next.adj, vwgt: next.vwgt };
    }

    // --- initial partition on the coarsest level -------------------------
    let { part, load } = initialPartition(cur.n, cur.adj, cur.vwgt, caps);
    fmRefine(cur.n, cur.adj, cur.vwgt, part, load, caps);

    // --- uncoarsen + refine ----------------------------------------------
    for (let i = levels.length - 1; i >= 0; i--) {
      const { fine, map } = levels[i];
      const finePart = new Int32Array(fine.n);
      for (let v = 0; v < fine.n; v++) finePart[v] = part[map[v]];
      const fineLoad = new Float64Array(P);
      for (let v = 0; v < fine.n; v++) fineLoad[finePart[v]] += fine.vwgt[v];
      fmRefine(fine.n, fine.adj, fine.vwgt, finePart, fineLoad, caps);
      part = finePart;
      load = fineLoad;
      cur = fine;
    }

    return bestOf(part, cutOf(edges, part), levels.length + 1);
  }

  DCP.Partition = { partition, cutOf, coarsen, initialPartition, fmRefine };
})(typeof globalThis !== "undefined" ? globalThis : this);
