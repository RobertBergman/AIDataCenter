/**
 * Shared primitives. Everything random in this planner runs off a seeded PRNG so
 * that the same design always produces byte-identical YAML -- a source of truth
 * that shuffles under you on every reload is not a source of truth.
 */
(function (root) {
  const DCP = (root.DCP = root.DCP || {});

  /** mulberry32 -- small, fast, good enough for annealing and matching. */
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const sum = (xs, f = (x) => x) => xs.reduce((a, x) => a + f(x), 0);
  const round = (v, dp = 2) => {
    const m = Math.pow(10, dp);
    return Math.round((v + Number.EPSILON) * m) / m;
  };
  const pad = (n, w = 2) => String(n).padStart(w, "0");

  /** Stable group-by preserving first-seen key order. */
  function groupBy(items, keyFn) {
    const out = new Map();
    for (const item of items) {
      const k = keyFn(item);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(item);
    }
    return out;
  }

  /** Binary min-heap keyed by numeric priority; used by Dijkstra/A*/
  class MinHeap {
    constructor() {
      this.items = [];
    }
    get size() {
      return this.items.length;
    }
    push(value, priority) {
      const items = this.items;
      items.push({ value, priority });
      let i = items.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (items[p].priority <= items[i].priority) break;
        [items[p], items[i]] = [items[i], items[p]];
        i = p;
      }
    }
    pop() {
      const items = this.items;
      if (items.length === 0) return undefined;
      const top = items[0];
      const last = items.pop();
      if (items.length > 0) {
        items[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let s = i;
          if (l < items.length && items[l].priority < items[s].priority) s = l;
          if (r < items.length && items[r].priority < items[s].priority) s = r;
          if (s === i) break;
          [items[s], items[i]] = [items[i], items[s]];
          i = s;
        }
      }
      return top.value;
    }
  }

  /** Manhattan distance -- racks are served by orthogonal tray runs, not straight lines. */
  const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

  DCP.Util = { rng, clamp, sum, round, pad, groupBy, MinHeap, manhattan };
})(typeof globalThis !== "undefined" ? globalThis : this);
