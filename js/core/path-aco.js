// Ant Colony Optimization for single-pair (source → destination) path finding
// on a directed road graph. This is a DIFFERENT objective from the TSP:
//   TSP   – a closed tour that must visit every required node exactly once.
//   Path  – any simple path from s to t; minimise total edge cost; nodes are optional.
//
// Each ant walks from s, at node i choosing an outgoing road (i,j) from its Allowed set with
//   P(i,j) = τ_ij^α · η_ij^β / Σ_{l∈Allowed} τ_il^α · η_il^β
//   η_ij  = 1 / (max(0, c_ij + h(j) − h(i)) + δ)   goal-directed visibility: the A*-style "reduced
//          cost", i.e. the detour an edge adds relative to heading straight for the goal. h is a
//          straight-line cost-to-go estimate; δ = ¼ of the mean edge cost keeps η finite.
// Loops in an ant's walk are erased on arrival, so every deposited route is a simple, connected
// path. After all ants finish:
//   τ ← (1 − ρ)·τ + Σ_k Q / L_k   on the edges of each successful ant k   (Ant System deposit)

import { createRng, rouletteSelect } from './rng.js';

export const PATH_DEFAULTS = Object.freeze({ alpha: 1, beta: 2, rho: 0.1, ants: 30, Q: 1 });

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

function sanitize(p) {
  const o = { ...PATH_DEFAULTS, ...p };
  o.alpha = clamp(num(o.alpha, 1), 0, 10);
  o.beta = clamp(num(o.beta, 2), 0, 15);
  o.rho = clamp(num(o.rho, 0.1), 0.001, 0.999);
  o.ants = Math.round(clamp(num(o.ants, 30), 1, 500));
  o.Q = clamp(num(o.Q, 1), 1e-9, 1e9);
  return o;
}

export class PathAco {
  /**
   * @param {import('./graph.js').Graph} graph
   * @param {(edgeIndex:number)=>number} costFn   current non-negative cost of an edge
   * @param {(node:number,target:number)=>number} lowerBoundFn  cost-to-go estimate used for η
   */
  constructor(graph, costFn, lowerBoundFn, params = {}, seed = 1) {
    this.g = graph;
    this.costFn = costFn;
    this.lowerBoundFn = lowerBoundFn;
    this.params = sanitize(params);
    this.seed = seed;
    this.s = -1;
    this.t = -1;
    this.stamp = new Int32Array(graph.n);
    this.blocked = new Int32Array(graph.n);
    this.stampVal = 0;
  }

  setParams(p) { this.params = sanitize({ ...this.params, ...p }); }

  setEndpoints(s, t, seed = this.seed) {
    if (!(s >= 0 && s < this.g.n && t >= 0 && t < this.g.n)) throw new Error('Origin/destination is not a graph node');
    this.s = s;
    this.t = t;
    this.reset(seed);
  }

  reset(seed = this.seed) {
    this.seed = seed;
    this.rng = createRng(seed);
    const E = this.g.edges.length;
    this.h = new Float64Array(this.g.n);
    for (let v = 0; v < this.g.n; v++) this.h[v] = this.t >= 0 ? this.lowerBoundFn(v, this.t) : 0;
    // τ0 = m·Q / L_est, with L_est a straight-line based estimate (no use of the exact optimum)
    const est = Math.max(1e-9, (this.t >= 0 ? this.h[this.s] : 1) * 1.3);
    this.tau0 = (this.params.ants * this.params.Q) / est;
    this.tau = new Float64Array(E).fill(this.tau0);
    this.computeDelta();
    this.iteration = 0;
    this.best = null; // { edges, cost, iteration }
    this.last = null;
    this.history = { best: [], iterBest: [], avg: [], success: [], events: [] };
    this.rhoLog = []; // ρ used at each iteration (for reconstructing edge history)
    this.depositLog = new Map(); // edge → [{it, dep, ants}]
    this.touched = new Set();
  }

  computeDelta() {
    let sum = 0;
    const E = this.g.edges.length;
    for (let e = 0; e < E; e++) sum += this.costFn(e);
    this.delta = Math.max(1e-9, (sum / Math.max(1, E)) * 0.25);
  }

  /** Visibility η of edge ei = 1 / (reduced cost + δ). */
  eta(ei) {
    const e = this.g.edges[ei];
    const reduced = Math.max(0, this.costFn(ei) + this.h[e.v] - this.h[e.u]);
    return 1 / (reduced + this.delta);
  }

  edgeWeightLog(ei) {
    const t = Math.max(this.tau[ei], 1e-300);
    return this.params.alpha * Math.log(t) + this.params.beta * Math.log(this.eta(ei));
  }

  /** Probabilities an ant at `node` would assign to each outgoing edge (no visited set). */
  choiceProbabilities(node, excludeNode = -1) {
    const cand = this.g.out[node].filter((ei) => this.g.edges[ei].v !== excludeNode);
    if (!cand.length) return [];
    const lw = cand.map((ei) => this.edgeWeightLog(ei));
    const mx = Math.max(...lw);
    const w = lw.map((v) => Math.exp(v - mx));
    const s = w.reduce((a, b) => a + b, 0);
    return cand.map((ei, k) => ({ edge: ei, to: this.g.edges[ei].v, p: w[k] / s }));
  }

  /**
   * One ant's walk. Allowed set at node u: outgoing roads to junctions this ant has not visited.
   * If none remain (common on one-way carriageways and roundabouts), revisits are permitted with a
   * strong penalty instead of abandoning the ant. Loops are erased when the ant arrives (loop
   * elimination, as in AntNet — Di Caro & Dorigo 1998), so every deposited route is a simple,
   * connected path.
   */
  walk(maxSteps) {
    const g = this.g;
    const st = ++this.stampVal;
    const visits = this.visits || (this.visits = new Int32Array(g.n));
    const stamp = this.stamp;
    let u = this.s;
    let prev = -1;
    const edges = [];
    stamp[u] = st; visits[u] = 1;
    const cand = [];
    const lw = [];
    for (let steps = 0; steps < maxSteps; steps++) {
      if (u === this.t) return eraseLoops(g, edges, this.s);
      const out = g.out[u];
      cand.length = 0; lw.length = 0;
      // 1) Allowed = unvisited junctions
      for (const ei of out) {
        const v = g.edges[ei].v;
        if (stamp[v] === st) continue;
        cand.push(ei); lw.push(this.edgeWeightLog(ei));
      }
      // 2) none left: allow revisits (still no immediate U-turn if avoidable), strongly discouraged
      if (!cand.length) {
        for (const ei of out) {
          const v = g.edges[ei].v;
          if (v === prev && out.length > 1) continue;
          cand.push(ei); lw.push(this.edgeWeightLog(ei) - 3 * visits[v]);
        }
      }
      if (!cand.length) return null; // only possible on a node without exits
      let mx = -Infinity;
      for (const v of lw) if (v > mx) mx = v;
      const w = lw.map((v) => Math.exp(v - mx));
      const ei = cand[rouletteSelect(w, this.rng)];
      const v = g.edges[ei].v;
      if (stamp[v] !== st) { stamp[v] = st; visits[v] = 0; }
      visits[v]++;
      edges.push(ei);
      prev = u;
      u = v;
    }
    return null; // step budget exhausted
  }

  step() {
    if (this.s < 0 || this.t < 0 || this.s === this.t) return null;
    const { ants, rho, Q } = this.params;
    const maxSteps = Math.max(500, this.g.n);
    const routes = [];
    let failed = 0;
    let sum = 0;
    let iterBest = null;
    for (let k = 0; k < ants; k++) {
      const edges = this.walk(maxSteps);
      if (!edges) { failed++; continue; }
      const cost = this.g.pathCost(edges, this.costFn);
      routes.push({ edges, cost });
      sum += cost;
      if (!iterBest || cost < iterBest.cost) iterBest = { edges, cost };
    }
    // Evaporation on all edges
    const tau = this.tau;
    const f = 1 - rho;
    for (let e = 0; e < tau.length; e++) tau[e] *= f;
    // Deposit
    const dep = new Map();
    for (const r of routes) {
      const d = Q / Math.max(r.cost, 1e-9);
      for (const ei of r.edges) {
        const cur = dep.get(ei) || { dep: 0, ants: 0 };
        cur.dep += d;
        cur.ants++;
        dep.set(ei, cur);
      }
    }
    this.iteration++;
    for (const [ei, d] of dep) {
      tau[ei] += d.dep;
      this.touched.add(ei);
      let log = this.depositLog.get(ei);
      if (!log) { log = []; this.depositLog.set(ei, log); }
      log.push({ it: this.iteration, dep: d.dep, ants: d.ants });
    }
    for (let e = 0; e < tau.length; e++) if (!(tau[e] >= 1e-300)) tau[e] = 1e-300;
    this.rhoLog.push(rho);
    if (iterBest && (!this.best || iterBest.cost < this.best.cost)) {
      this.best = { edges: iterBest.edges.slice(), cost: iterBest.cost, iteration: this.iteration };
    }
    const avg = routes.length ? sum / routes.length : NaN;
    this.history.best.push(this.best ? this.best.cost : NaN);
    this.history.iterBest.push(iterBest ? iterBest.cost : NaN);
    this.history.avg.push(avg);
    this.history.success.push(routes.length / ants);
    this.last = { iteration: this.iteration, routes, failed, iterBest, avg, deposits: dep };
    return this.last;
  }

  /** Call when edge costs change (congestion / objective). Keeps τ, re-prices the stored best. */
  costsChanged(label = 'costs changed') {
    for (let v = 0; v < this.g.n; v++) this.h[v] = this.lowerBoundFn(v, this.t);
    this.computeDelta();
    if (this.best) this.best.cost = this.g.pathCost(this.best.edges, this.costFn);
    this.history.events.push({ iteration: this.iteration, label });
  }

  /** Pheromone history of one edge, reconstructed exactly from τ0, ρ log and deposits. */
  edgeHistory(ei) {
    const log = this.depositLog.get(ei) || [];
    const out = [];
    let tau = this.tau0;
    let k = 0;
    const start = Math.max(0, this.iteration - 300);
    for (let it = 1; it <= this.iteration; it++) {
      tau *= 1 - this.rhoLog[it - 1];
      let d = 0;
      let a = 0;
      if (k < log.length && log[k].it === it) { d = log[k].dep; a = log[k].ants; k++; }
      tau = Math.max(1e-300, tau + d);
      if (it > start) out.push({ it, tau, dep: d, ants: a });
    }
    return out;
  }

  maxTau() {
    let m = 0;
    for (const ei of this.touched) if (this.tau[ei] > m) m = this.tau[ei];
    return Math.max(m, this.tau0 * Math.pow(1 - this.params.rho, this.iteration));
  }
}

/** Remove cycles from a walk s→…→t, keeping the first arrival order (loop-erased walk). */
export function eraseLoops(g, walkEdges, s) {
  const out = [];
  const pos = new Map([[s, 0]]); // node → index in `out` after which it was reached
  for (const ei of walkEdges) {
    const v = g.edges[ei].v;
    if (pos.has(v)) {
      const k = pos.get(v);
      // drop the cycle that returned to v
      for (let i = k; i < out.length; i++) pos.delete(g.edges[out[i]].v);
      out.length = k;
      pos.set(v, k);
    } else {
      out.push(ei);
      pos.set(v, out.length);
    }
  }
  return out;
}
