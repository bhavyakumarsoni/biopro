// Ant System (Dorigo, Maniezzo & Colorni, 1996) for the symmetric Travelling
// Salesperson Problem. Pure logic: no DOM, so it can be unit-tested in Node.
//
//   P(i,j) = τ(i,j)^α · η(i,j)^β / Σ_{l∈Allowed} τ(i,l)^α · η(i,l)^β,  η = 1/d
//   τ(i,j) ← (1 − ρ)·τ(i,j) + Σ_k Δτ_k(i,j),   Δτ_k(i,j) = Q / L_k if ant k used (i,j)
//
// Objective: a closed tour visiting every node exactly once (Hamiltonian cycle).

import { createRng, rouletteSelect } from './rng.js';

export const TSP_DEFAULTS = Object.freeze({ alpha: 1, beta: 3, rho: 0.1, ants: 30, Q: 1 });
const MIN_DIST = 1e-9;
const HISTORY_LIMIT = 400; // per-edge pheromone history retained (iterations)

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function distanceMatrix(nodes) {
  const n = nodes.length;
  const d = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const v = Math.max(distance(nodes[i], nodes[j]), MIN_DIST);
      d[i][j] = v;
      d[j][i] = v;
    }
  }
  return d;
}

export function tourLength(tour, dist) {
  let len = 0;
  for (let k = 0; k < tour.length; k++) {
    len += dist[tour[k]][tour[(k + 1) % tour.length]];
  }
  return len;
}

/** A tour is valid if it is a permutation of 0..n-1. */
export function isValidTour(tour, n) {
  if (!Array.isArray(tour) || tour.length !== n) return false;
  const seen = new Uint8Array(n);
  for (const v of tour) {
    if (!Number.isInteger(v) || v < 0 || v >= n || seen[v]) return false;
    seen[v] = 1;
  }
  return true;
}

export function nearestNeighbourTour(dist, start = 0) {
  const n = dist.length;
  const visited = new Uint8Array(n);
  const tour = [start];
  visited[start] = 1;
  for (let step = 1; step < n; step++) {
    const cur = tour[tour.length - 1];
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < n; j++) {
      if (!visited[j] && dist[cur][j] < bestD) { bestD = dist[cur][j]; best = j; }
    }
    tour.push(best);
    visited[best] = 1;
  }
  return tour;
}

/**
 * Exact optimum by Held–Karp dynamic programming, O(n² 2ⁿ).
 * Practical in a browser up to ~17 nodes. Returns null when n is too large.
 */
export function heldKarp(dist, maxN = 17) {
  const n = dist.length;
  if (n < 2) return { tour: n ? [0] : [], length: 0 };
  if (n > maxN) return null;
  if (n === 2) return { tour: [0, 1], length: dist[0][1] * 2 };
  const m = n - 1; // node 0 fixed as start; others are bits 0..m-1 (node = bit+1)
  const FULL = 1 << m;
  const dp = new Float64Array(FULL * m).fill(Infinity);
  const parent = new Int8Array(FULL * m).fill(-1);
  for (let k = 0; k < m; k++) dp[(1 << k) * m + k] = dist[0][k + 1];
  for (let mask = 1; mask < FULL; mask++) {
    for (let last = 0; last < m; last++) {
      if (!(mask & (1 << last))) continue;
      const cur = dp[mask * m + last];
      if (cur === Infinity) continue;
      for (let nx = 0; nx < m; nx++) {
        if (mask & (1 << nx)) continue;
        const nm = mask | (1 << nx);
        const v = cur + dist[last + 1][nx + 1];
        if (v < dp[nm * m + nx]) { dp[nm * m + nx] = v; parent[nm * m + nx] = last; }
      }
    }
  }
  let best = Infinity;
  let bestLast = -1;
  for (let k = 0; k < m; k++) {
    const v = dp[(FULL - 1) * m + k] + dist[k + 1][0];
    if (v < best) { best = v; bestLast = k; }
  }
  const tour = [];
  let mask = FULL - 1;
  let cur = bestLast;
  while (cur !== -1) {
    tour.push(cur + 1);
    const p = parent[mask * m + cur];
    mask &= ~(1 << cur);
    cur = p;
  }
  tour.push(0);
  tour.reverse();
  return { tour, length: best };
}

function sanitizeParams(p) {
  const out = { ...TSP_DEFAULTS, ...p };
  out.alpha = clamp(num(out.alpha, 1), 0, 10);
  out.beta = clamp(num(out.beta, 3), 0, 15);
  out.rho = clamp(num(out.rho, 0.1), 0.001, 0.999);
  out.ants = Math.round(clamp(num(out.ants, 30), 1, 500));
  out.Q = clamp(num(out.Q, 1), 1e-6, 1e6);
  return out;
}
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class TspAntSystem {
  constructor(nodes, params = {}, seed = 1) {
    this.params = sanitizeParams(params);
    this.setNodes(nodes, seed);
  }

  setNodes(nodes, seed = this.seed ?? 1) {
    this.nodes = nodes.map((p) => ({ x: Number(p.x), y: Number(p.y) }));
    this.reset(seed);
  }

  setParams(p) {
    this.params = sanitizeParams({ ...this.params, ...p });
  }

  /** Full reset: pheromone back to τ0, histories and best solution cleared. */
  reset(seed = this.seed) {
    this.seed = seed;
    this.rng = createRng(seed);
    const n = this.nodes.length;
    this.n = n;
    this.dist = distanceMatrix(this.nodes);
    this.iteration = 0;
    this.best = null; // { tour, length, iteration }
    this.lastIteration = null;
    this.history = { best: [], iterBest: [], avg: [] };
    this.edgeHistory = new Map();
    if (n >= 2) {
      this.nnLength = tourLength(nearestNeighbourTour(this.dist), this.dist);
      // Standard AS initialisation: τ0 = m / C_nn
      this.tau0 = this.params.ants / this.nnLength;
    } else {
      this.nnLength = 0;
      this.tau0 = 1;
    }
    this.tau = Array.from({ length: n }, () => new Float64Array(n).fill(this.tau0));
    for (let i = 0; i < n; i++) this.tau[i][i] = 0;
  }

  /** Normalised transition probabilities from node i given a visited mask. */
  transitionProbabilities(i, visited = null) {
    const n = this.n;
    const { alpha, beta } = this.params;
    const cand = [];
    const logw = [];
    for (let j = 0; j < n; j++) {
      if (j === i || (visited && visited[j])) continue;
      const t = Math.max(this.tau[i][j], 1e-300);
      const eta = 1 / this.dist[i][j];
      cand.push(j);
      logw.push(alpha * Math.log(t) + beta * Math.log(eta));
    }
    if (!cand.length) return [];
    // log-sum-exp for numerical stability with large α/β
    const mx = Math.max(...logw);
    const w = logw.map((v) => Math.exp(v - mx));
    const s = w.reduce((a, b) => a + b, 0);
    return cand.map((j, k) => ({ j, p: w[k] / s, tau: this.tau[i][j], eta: 1 / this.dist[i][j] }));
  }

  constructTour(start) {
    const n = this.n;
    const visited = new Uint8Array(n);
    const tour = [start];
    visited[start] = 1;
    for (let step = 1; step < n; step++) {
      const cur = tour[tour.length - 1];
      const probs = this.transitionProbabilities(cur, visited);
      const idx = rouletteSelect(probs.map((c) => c.p), this.rng);
      const nxt = probs[idx].j;
      tour.push(nxt);
      visited[nxt] = 1;
    }
    return tour;
  }

  /** One full iteration: m ants build tours, then evaporation + deposit. */
  step() {
    const n = this.n;
    if (n < 3) return null;
    const { ants, rho, Q } = this.params;
    const tours = [];
    let sum = 0;
    let iterBest = null;
    for (let k = 0; k < ants; k++) {
      const tour = this.constructTour(this.rng.int(n));
      const L = tourLength(tour, this.dist);
      tours.push({ tour, length: L });
      sum += L;
      if (!iterBest || L < iterBest.length) iterBest = { tour, length: L };
    }
    // Evaporation on every edge
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) if (i !== j) this.tau[i][j] *= 1 - rho;
    }
    // Deposit: Δτ(i,j) = Σ_k Q / L_k   (Ant System — every ant deposits)
    const deposit = Array.from({ length: n }, () => new Float64Array(n));
    const usage = Array.from({ length: n }, () => new Uint16Array(n));
    for (const { tour, length } of tours) {
      const d = Q / length;
      for (let s = 0; s < n; s++) {
        const a = tour[s];
        const b = tour[(s + 1) % n];
        deposit[a][b] += d;
        deposit[b][a] += d;
        usage[a][b]++;
        usage[b][a]++;
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        let v = this.tau[i][j] + deposit[i][j];
        if (!Number.isFinite(v) || v < 1e-300) v = 1e-300; // numerical guard only
        this.tau[i][j] = v;
      }
    }
    this.iteration++;
    if (!this.best || iterBest.length < this.best.length) {
      this.best = { tour: iterBest.tour.slice(), length: iterBest.length, iteration: this.iteration };
    }
    const avg = sum / ants;
    this.history.best.push(this.best.length);
    this.history.iterBest.push(iterBest.length);
    this.history.avg.push(avg);
    // Per-edge history (upper triangle)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const key = i * 1000 + j;
        let h = this.edgeHistory.get(key);
        if (!h) { h = []; this.edgeHistory.set(key, h); }
        h.push({ it: this.iteration, tau: this.tau[i][j], dep: deposit[i][j], ants: usage[i][j] });
        if (h.length > HISTORY_LIMIT) h.shift();
      }
    }
    this.lastIteration = { iteration: this.iteration, tours, iterBest, avg, deposit, usage };
    return this.lastIteration;
  }

  edgeInfo(i, j) {
    if (i === j || i < 0 || j < 0 || i >= this.n || j >= this.n) return null;
    const a = Math.min(i, j);
    const b = Math.max(i, j);
    const last = this.lastIteration;
    return {
      i: a,
      j: b,
      tau: this.tau[a][b],
      distance: this.dist[a][b],
      eta: 1 / this.dist[a][b],
      lastDeposit: last ? last.deposit[a][b] : 0,
      lastAnts: last ? last.usage[a][b] : 0,
      inBest: !!this.best && tourHasEdge(this.best.tour, a, b),
      history: (this.edgeHistory.get(a * 1000 + b) || []).slice(),
    };
  }

  maxTau() {
    let m = 0;
    for (let i = 0; i < this.n; i++) for (let j = i + 1; j < this.n; j++) m = Math.max(m, this.tau[i][j]);
    return m;
  }
}

export function tourHasEdge(tour, a, b) {
  for (let k = 0; k < tour.length; k++) {
    const u = tour[k];
    const v = tour[(k + 1) % tour.length];
    if ((u === a && v === b) || (u === b && v === a)) return true;
  }
  return false;
}

/** Graph presets in a fixed logical coordinate space (1000 × 600 units). */
export const WORLD = { w: 1000, h: 600 };

export function makePreset(type, rng, count = 12) {
  const { w, h } = WORLD;
  const pts = [];
  if (type === 'circle') {
    const r = Math.min(w, h) * 0.38;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 - Math.PI / 2;
      pts.push({ x: w / 2 + r * Math.cos(a), y: h / 2 + r * Math.sin(a) });
    }
  } else if (type === 'clusters') {
    const centers = [{ x: w * 0.22, y: h * 0.3 }, { x: w * 0.78, y: h * 0.3 }, { x: w * 0.5, y: h * 0.75 }];
    const per = Math.max(2, Math.round(count / centers.length));
    for (const c of centers) {
      for (let i = 0; i < per; i++) {
        pts.push({ x: c.x + rng.range(-75, 75), y: c.y + rng.range(-65, 65) });
      }
    }
  } else if (type === 'grid') {
    const cols = 4;
    const rows = Math.ceil(count / cols);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols && pts.length < count; c++) {
        pts.push({ x: 200 + c * 200, y: 120 + r * (360 / Math.max(1, rows - 1)) });
      }
    }
  } else {
    const pad = 60;
    let guard = 0;
    while (pts.length < count && guard++ < 5000) {
      const p = { x: rng.range(pad, w - pad), y: rng.range(pad, h - pad) };
      if (pts.every((q) => distance(p, q) > 45)) pts.push(p);
    }
  }
  return pts;
}

/** Perimeter of a regular polygon tour — the known optimum for the circle preset. */
export function circleOptimum(nodes) {
  return tourLength(nodes.map((_, i) => i), distanceMatrix(nodes));
}
