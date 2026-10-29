// Directed weighted graph utilities + Dijkstra (binary heap). Pure logic.

export const EARTH_RADIUS_M = 6371008.8;

export function haversine(lat1, lng1, lat2, lng2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * @param {number} nodeCount
 * @param {{u:number,v:number}[]} edges  directed edges (extra fields are kept)
 */
export class Graph {
  constructor(nodeCount, edges) {
    this.n = nodeCount;
    this.edges = edges;
    this.out = Array.from({ length: nodeCount }, () => []);
    edges.forEach((e, idx) => {
      if (!(e.u >= 0 && e.u < nodeCount && e.v >= 0 && e.v < nodeCount)) {
        throw new Error(`Edge ${idx} references a missing node (${e.u} → ${e.v})`);
      }
      this.out[e.u].push(idx);
    });
  }

  /** True if consecutive edges in `edgePath` connect head-to-tail from s to t. */
  isConnectedPath(edgePath, s, t) {
    if (!edgePath.length) return s === t;
    let cur = s;
    for (const ei of edgePath) {
      const e = this.edges[ei];
      if (!e || e.u !== cur) return false;
      cur = e.v;
    }
    return cur === t;
  }

  pathCost(edgePath, costFn) {
    let c = 0;
    for (const ei of edgePath) c += costFn(ei);
    return c;
  }

  nodesOf(edgePath, s) {
    const nodes = [s];
    for (const ei of edgePath) nodes.push(this.edges[ei].v);
    return nodes;
  }
}

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k; const v = this.v;
    k.push(key); v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop() {
    const k = this.k; const v = this.v;
    const topK = k[0]; const topV = v[0];
    const lk = k.pop(); const lv = v.pop();
    if (k.length) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1; const r = l + 1; let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return [topK, topV];
  }
}

/**
 * Dijkstra's algorithm. Requires non-negative costs (validated).
 * Returns { edges, nodes, cost, settled } or { edges: null, cost: Infinity } if unreachable.
 */
export function dijkstra(graph, costFn, s, t) {
  const n = graph.n;
  const dist = new Float64Array(n).fill(Infinity);
  const prevEdge = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[s] = 0;
  const heap = new MinHeap();
  heap.push(0, s);
  let settled = 0;
  while (heap.size) {
    const [d, u] = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    settled++;
    if (u === t) break;
    for (const ei of graph.out[u]) {
      const c = costFn(ei);
      if (!(c >= 0) || !Number.isFinite(c)) throw new Error(`Invalid edge cost ${c} on edge ${ei}`);
      const v = graph.edges[ei].v;
      const nd = d + c;
      if (nd < dist[v]) { dist[v] = nd; prevEdge[v] = ei; heap.push(nd, v); }
    }
  }
  if (dist[t] === Infinity) return { edges: null, nodes: null, cost: Infinity, settled };
  const edges = [];
  let cur = t;
  while (cur !== s) {
    const ei = prevEdge[cur];
    edges.push(ei);
    cur = graph.edges[ei].u;
  }
  edges.reverse();
  return { edges, nodes: graph.nodesOf(edges, s), cost: dist[t], settled };
}

/** Strongly connected components (iterative Tarjan). Returns component id per node. */
export function stronglyConnectedComponents(n, out, headOf) {
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const comp = new Int32Array(n).fill(-1);
  const stack = [];
  let idx = 0;
  let c = 0;
  for (let s = 0; s < n; s++) {
    if (index[s] !== -1) continue;
    const work = [[s, 0]];
    while (work.length) {
      const top = work[work.length - 1];
      const [v, pi] = top;
      if (pi === 0) {
        index[v] = low[v] = idx++;
        stack.push(v); onStack[v] = 1;
      }
      if (pi < out[v].length) {
        top[1]++;
        const w = headOf(out[v][pi]);
        if (index[w] === -1) work.push([w, 0]);
        else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
      } else {
        work.pop();
        if (work.length) {
          const p = work[work.length - 1][0];
          low[p] = Math.min(low[p], low[v]);
        }
        if (low[v] === index[v]) {
          let w;
          do { w = stack.pop(); onStack[w] = 0; comp[w] = c; } while (w !== v);
          c++;
        }
      }
    }
  }
  return comp;
}
