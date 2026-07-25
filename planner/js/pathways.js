/**
 * Pathway graph, congestion-aware routing, and trunk (Steiner) bundling.
 *
 * Cables do not fly between racks; they climb to a tray, run along an aisle,
 * cross rows at a ladder, and drop into the far rack. This module builds that
 * skeleton and routes over it, so the length written into the cable schedule is
 * a *buildable* length -- which is what decides DAC vs AEC vs AOC vs fiber.
 *
 * Cost of traversing a tray segment:
 *
 *   w = length · (1 + congestion_weight · fill)   ← congestion
 *       + bend_penalty if the run changes axis    ← bends
 *
 * so the cheapest route is frequently not the physically shortest one. Fill is
 * updated after every reservation, which makes routing order-dependent in the
 * same way real installs are: the first trunks get the good pathway.
 *
 * Data and power run on separate tiers (different tray heights, no shared
 * segments) -- both because it is a real separation rule and because it lets the
 * A/B power feeds be routed genuinely disjoint from each other.
 */
(function (root) {
  const DCP = (root.DCP = root.DCP || {});

  const TRAY = {
    data: { w_mm: 300, h_mm: 100, fill: 0.4 },
    power: { w_mm: 300, h_mm: 100, fill: 0.4 },
    // Coolant runs in its own reservation so hoses and fibre never contend for
    // the same tray -- and so a wet pathway is never above a live one.
    fluid: { w_mm: 400, h_mm: 200, fill: 0.5 },
  };
  const RACK_TOP_M = 2.1;      // cable exit height at the top of a frame
  const LADDER_EVERY = 6;      // cross-aisle tray ladders every N slots
  const AREA = (od_mm) => (Math.PI / 4) * od_mm * od_mm;

  function trayCapacity(tier) {
    const t = TRAY[tier] || TRAY.data;
    return t.w_mm * t.h_mm * t.fill;
  }

  /**
   * Build the tray skeleton for one tier: a spine of nodes over every aisle, at
   * every slot column, plus cross-aisle ladders at both ends and every
   * LADDER_EVERY columns.
   */
  function buildTier(floor, tierName, height_m, runs = 1) {
    const nodes = [];
    const adj = [];
    const edges = [];
    // A real hall hangs several tray runs side by side over an aisle; `runs`
    // multiplies the usable cross-section rather than pretending one basket
    // carries the whole hall.
    const cap = trayCapacity(tierName) * Math.max(1, runs);

    const addNode = (x, y, kind, key) => {
      const i = nodes.length;
      nodes.push({ i, x, y, kind, key: key || null });
      adj.push([]);
      return i;
    };

    const addEdge = (a, b, extraLen = 0) => {
      const dx = Math.abs(nodes[a].x - nodes[b].x);
      const dy = Math.abs(nodes[a].y - nodes[b].y);
      const len = dx + dy + extraLen;
      const dir = dx >= dy ? 0 : 1; // 0 = along X (in-row), 1 = along Y (cross-aisle)
      const e = edges.length;
      edges.push({ e, a, b, len, dir, cap, used: 0, count: 0 });
      adj[a].push({ v: b, e });
      adj[b].push({ v: a, e });
      return e;
    };

    // Aisle spine: one node per (aisle, slot column).
    const aisleNodes = floor.aisles.map(() => []);
    const columnX = [];
    for (let s = 0; s < floor.slotsPerRow; s++) {
      columnX.push(floor.usable.x0 + (s + 0.5) * floor.pitch);
    }
    // End-of-row columns so a route can always get around the end of a row.
    const endX = [floor.usable.x0 - 0.4, floor.usable.x1 + 0.4];

    floor.aisles.forEach((aisle, ai) => {
      const xs = [endX[0], ...columnX, endX[1]];
      let prev = -1;
      xs.forEach((x, k) => {
        const n = addNode(x, aisle.y, "aisle", `${tierName}:a${ai}:${k}`);
        aisleNodes[ai].push(n);
        if (prev >= 0) addEdge(prev, n);
        prev = n;
      });
    });

    // Cross-aisle ladders: vertical rungs joining consecutive aisles.
    for (let ai = 0; ai + 1 < floor.aisles.length; ai++) {
      const upper = aisleNodes[ai];
      const lower = aisleNodes[ai + 1];
      for (let k = 0; k < upper.length; k++) {
        const isEnd = k === 0 || k === upper.length - 1;
        const isLadder = (k - 1) % LADDER_EVERY === 0;
        if (!isEnd && !isLadder) continue;
        addEdge(upper[k], lower[k]);
      }
    }

    return {
      tier: tierName, height_m, nodes, adj, edges, aisleNodes, columnX, endX,
      drops: new Map(), floor, addNode, addEdge, cap,
    };
  }

  /**
   * Attach a drop for a rack or a piece of floor equipment. A rack is served by
   * both the aisle in front of it and the aisle behind it -- installers use
   * whichever side has room, and so does the router.
   */
  function addDrop(g, key, x, y) {
    if (g.drops.has(key)) return g.drops.get(key);
    const n = g.addNode(x, y, "drop", key);
    g.drops.set(key, n);

    // Two nearest aisles by centreline distance.
    const ranked = g.floor.aisles
      .map((a, ai) => ({ ai, d: Math.abs(a.y - y) }))
      .sort((p, q) => p.d - q.d)
      .slice(0, 2);

    // Overhead tiers climb from the top of the frame; an underfloor tier drops
    // from the frame base instead, so it is the tier height that is travelled.
    const rise = g.height_m > RACK_TOP_M ? g.height_m - RACK_TOP_M : g.height_m;
    for (const { ai } of ranked) {
      const spine = g.aisleNodes[ai];
      let best = spine[0];
      let bestD = Infinity;
      for (const nd of spine) {
        const d = Math.abs(g.nodes[nd].x - x);
        if (d < bestD) {
          bestD = d;
          best = nd;
        }
      }
      // The rise up to the tray is real cable, so it belongs in the length.
      g.addEdge(n, best, rise);
    }
    return n;
  }

  /**
   * A* with a direction-aware state so bends can be penalised.
   * `avoid` is a Set of edge ids whose cost is multiplied by `avoidFactor`
   * (used for A/B power diversity, where sharing a tray is legal but bad).
   */
  function route(g, fromKey, toKey, opts = {}) {
    const src = g.drops.get(fromKey);
    const dst = g.drops.get(toKey);
    if (src === undefined || dst === undefined) return null;
    if (src === dst) return { length_m: 0, edges: [], bends: 0, nodes: [src] };

    const congestion = opts.congestion_weight ?? 0.6;
    const bendPenalty = opts.bend_penalty_m ?? 1.5;
    const avoid = opts.avoid || null;
    const avoidFactor = opts.avoidFactor ?? 6;
    const banned = opts.banned || null;
    // Segments already carrying a trunk are cheap to join (see steiner()).
    const prefer = opts.preferEdges || null;
    const PREFER_FACTOR = 0.05;

    const target = g.nodes[dst];
    // Scaled so the heuristic stays admissible when discounted edges are in play.
    const hScale = prefer ? PREFER_FACTOR : 1;
    const h = (n) => hScale * (Math.abs(g.nodes[n].x - target.x) + Math.abs(g.nodes[n].y - target.y));

    const N = g.nodes.length;
    const dist = new Float64Array(N * 2).fill(Infinity);
    const prev = new Int32Array(N * 2).fill(-1);
    const prevEdge = new Int32Array(N * 2).fill(-1);
    const seen = new Uint8Array(N * 2);
    const heap = new DCP.Util.MinHeap();

    for (const d of [0, 1]) {
      dist[src * 2 + d] = 0;
      heap.push(src * 2 + d, h(src));
    }

    while (heap.size) {
      const s = heap.pop();
      if (seen[s]) continue;
      seen[s] = 1;
      const u = s >> 1;
      const dirIn = s & 1;
      if (u === dst) break;

      for (const { v, e } of g.adj[u]) {
        if (banned && banned.has(e)) continue;
        const meta = g.edges[e];
        const fill = meta.cap > 0 ? Math.min(1.5, meta.used / meta.cap) : 0;
        let w = prefer && prefer.has(e) ? meta.len * PREFER_FACTOR : meta.len * (1 + congestion * fill);
        if (meta.dir !== dirIn) w += bendPenalty;
        if (avoid && avoid.has(e)) w *= avoidFactor;

        const ns = v * 2 + meta.dir;
        const nd = dist[s] + w;
        if (nd < dist[ns]) {
          dist[ns] = nd;
          prev[ns] = s;
          prevEdge[ns] = e;
          heap.push(ns, nd + h(v));
        }
      }
    }

    let bestState = -1;
    for (const d of [0, 1]) {
      const s = dst * 2 + d;
      if (dist[s] < Infinity && (bestState < 0 || dist[s] < dist[bestState])) bestState = s;
    }
    if (bestState < 0) return null;

    const usedEdges = [];
    const nodePath = [];
    let s = bestState;
    let bends = 0;
    let lastDir = -1;
    while (s >= 0) {
      nodePath.push(s >> 1);
      const e = prevEdge[s];
      if (e >= 0) {
        usedEdges.push(e);
        if (lastDir >= 0 && g.edges[e].dir !== lastDir) bends++;
        lastDir = g.edges[e].dir;
      }
      s = prev[s];
    }
    usedEdges.reverse();
    nodePath.reverse();

    const length_m = DCP.Util.sum(usedEdges, (e) => g.edges[e].len);
    return { length_m, edges: usedEdges, bends, nodes: nodePath, weighted: dist[bestState] };
  }

  /**
   * Yen's K-shortest paths. Used to pick a B-feed route that shares as few tray
   * segments as possible with the already-committed A-feed route.
   */
  function kShortest(g, fromKey, toKey, K, opts = {}) {
    const first = route(g, fromKey, toKey, opts);
    if (!first) return [];
    const A = [first];
    const B = [];

    for (let k = 1; k < K; k++) {
      const prevPath = A[k - 1];
      for (let i = 0; i < prevPath.edges.length; i++) {
        const banned = new Set(opts.banned || []);
        // Ban the i-th edge of every previously found path sharing this prefix.
        for (const p of A) {
          if (p.edges.length > i && p.edges.slice(0, i).join(",") === prevPath.edges.slice(0, i).join(",")) {
            banned.add(p.edges[i]);
          }
        }
        const cand = route(g, fromKey, toKey, { ...opts, banned });
        if (cand && !A.some((p) => p.edges.join(",") === cand.edges.join(",")) &&
            !B.some((p) => p.edges.join(",") === cand.edges.join(","))) {
          B.push(cand);
        }
      }
      if (B.length === 0) break;
      B.sort((a, b) => a.weighted - b.weighted);
      A.push(B.shift());
    }
    return A;
  }

  /**
   * Steiner tree over the pathway graph (shortest-path heuristic, KMB-style):
   * grow a tree from the root, repeatedly splicing in the nearest terminal not
   * yet connected.
   *
   * This is what turns 64 independent spine→leaf cables into a handful of shared
   * trunk runs: every terminal's path is expressed along tree segments, so the
   * bundler can group cables that share segments into MPO trunks and the tray
   * only ever carries the trunk, not 64 separate jackets.
   */
  function steiner(g, rootKey, terminalKeys, opts = {}) {
    const root = g.drops.get(rootKey);
    if (root === undefined) return null;
    const terminals = terminalKeys.map((k) => ({ key: k, node: g.drops.get(k) })).filter((t) => t.node !== undefined);

    const congestion = opts.congestion_weight ?? 0.6;
    const treeNodes = new Set([root]);
    const treeEdges = new Set();
    const paths = new Map();
    const pending = new Set(terminals.map((t) => t.node));
    const keyOf = new Map(terminals.map((t) => [t.node, t.key]));

    while (pending.size) {
      // Multi-source Dijkstra from the current tree.
      const N = g.nodes.length;
      const dist = new Float64Array(N).fill(Infinity);
      const prev = new Int32Array(N).fill(-1);
      const prevEdge = new Int32Array(N).fill(-1);
      const seen = new Uint8Array(N);
      const heap = new DCP.Util.MinHeap();
      for (const n of treeNodes) {
        dist[n] = 0;
        heap.push(n, 0);
      }

      let found = -1;
      while (heap.size) {
        const u = heap.pop();
        if (seen[u]) continue;
        seen[u] = 1;
        if (pending.has(u)) {
          found = u;
          break;
        }
        for (const { v, e } of g.adj[u]) {
          const meta = g.edges[e];
          const fill = meta.cap > 0 ? Math.min(1.5, meta.used / meta.cap) : 0;
          // Segments already in the tree are nearly free: reusing a trunk run is
          // exactly the behaviour we want out of a Steiner formulation.
          const w = treeEdges.has(e) ? meta.len * 0.05 : meta.len * (1 + congestion * fill);
          if (dist[u] + w < dist[v]) {
            dist[v] = dist[u] + w;
            prev[v] = u;
            prevEdge[v] = e;
            heap.push(v, dist[v]);
          }
        }
      }
      if (found < 0) break;

      const segs = [];
      let cur = found;
      while (prev[cur] >= 0) {
        segs.push(prevEdge[cur]);
        treeNodes.add(cur);
        cur = prev[cur];
      }
      segs.reverse();
      for (const e of segs) treeEdges.add(e);
      treeNodes.add(found);
      pending.delete(found);

      // Full root→terminal path along tree segments, for the cable length.
      const full = route(g, rootKey, keyOf.get(found), {
        ...opts,
        preferEdges: treeEdges,
      });
      paths.set(keyOf.get(found), full || { length_m: DCP.Util.sum(segs, (e) => g.edges[e].len), edges: segs, bends: 0 });
    }

    return {
      edges: [...treeEdges],
      length_m: DCP.Util.sum([...treeEdges], (e) => g.edges[e].len),
      paths,
    };
  }

  /** Commit a routed cable's cross-section into the trays it uses. */
  function reserve(g, edgeIds, od_mm, count = 1) {
    const area = AREA(od_mm) * count;
    for (const e of edgeIds) {
      g.edges[e].used += area;
      g.edges[e].count += count;
    }
  }

  /** Peak and mean tray fill, plus the worst offenders for the UI overlay. */
  function utilization(g) {
    let peak = 0;
    let total = 0;
    let n = 0;
    const hot = [];
    for (const e of g.edges) {
      if (e.cap <= 0) continue;
      const fill = e.used / e.cap;
      peak = Math.max(peak, fill);
      total += fill;
      n++;
      if (fill > 0.8) hot.push({ e: e.e, fill: DCP.Util.round(fill, 3), count: e.count });
    }
    hot.sort((a, b) => b.fill - a.fill);
    return {
      peak_fill: DCP.Util.round(peak, 3),
      mean_fill: DCP.Util.round(n ? total / n : 0, 3),
      over_fill_segments: hot.filter((h) => h.fill > 1).length,
      hottest: hot.slice(0, 12),
    };
  }

  function build(floor, design) {
    // Coolant goes under the floor when there is one, otherwise low overhead --
    // either way, below the electrical tier.
    const fluidHeight = design.room.raised_floor ? 0.3 : 0.5;
    return {
      data: buildTier(floor, "data", design.room.tray_height_m, design.room.data_tray_runs),
      power: buildTier(floor, "power", design.room.power_tray_height_m, design.room.power_tray_runs),
      fluid: buildTier(floor, "fluid", fluidHeight, design.room.fluid_tray_runs),
    };
  }

  DCP.Pathways = {
    build, buildTier, addDrop, route, kShortest, steiner, reserve, utilization,
    trayCapacity, AREA, TRAY, RACK_TOP_M,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
