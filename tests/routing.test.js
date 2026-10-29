import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Graph, dijkstra, haversine, stronglyConnectedComponents } from '../js/core/graph.js';
import { PathAco } from '../js/core/path-aco.js';
import { RoadNetwork, LANDMARKS } from '../js/core/roadgraph.js';
import { createRng } from '../js/core/rng.js';

// Random directed grid-like graph with Euclidean coordinates (so a straight-line bound is admissible).
function randomGraph(seed, w = 6, h = 5) {
  const rng = createRng(seed);
  const pts = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pts.push({ x: x * 10 + rng.range(-2, 2), y: y * 10 + rng.range(-2, 2) });
  const edges = [];
  const add = (a, b) => { const d = Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y); edges.push({ u: a, v: b, d: d * rng.range(1, 1.6) }); };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x + 1 < w) { add(i, i + 1); add(i + 1, i); }
      if (y + 1 < h) { add(i, i + w); if (rng.next() < 0.8) add(i + w, i); }
      if (x + 1 < w && y + 1 < h && rng.next() < 0.3) add(i, i + w + 1);
    }
  }
  const g = new Graph(pts.length, edges);
  return { g, pts, cost: (ei) => g.edges[ei].d, lb: (v, t) => Math.hypot(pts[v].x - pts[t].x, pts[v].y - pts[t].y) };
}

function bruteForceShortest(g, cost, s, t) {
  let best = Infinity;
  const seen = new Uint8Array(g.n);
  const dfs = (u, c) => {
    if (c >= best) return;
    if (u === t) { best = c; return; }
    seen[u] = 1;
    for (const ei of g.out[u]) { const v = g.edges[ei].v; if (!seen[v]) dfs(v, c + cost(ei)); }
    seen[u] = 0;
  };
  dfs(s, 0);
  return best;
}

test('Dijkstra matches exhaustive search on random graphs', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const { g, cost } = randomGraph(seed, 4, 4);
    const r = dijkstra(g, cost, 0, g.n - 1);
    assert.ok(Math.abs(r.cost - bruteForceShortest(g, cost, 0, g.n - 1)) < 1e-9, `seed ${seed}`);
    assert.ok(g.isConnectedPath(r.edges, 0, g.n - 1));
    assert.ok(Math.abs(g.pathCost(r.edges, cost) - r.cost) < 1e-9);
  }
});

test('Dijkstra rejects negative / NaN costs and reports unreachable targets', () => {
  const g = new Graph(3, [{ u: 0, v: 1 }, { u: 1, v: 0 }]);
  assert.throws(() => dijkstra(g, () => -1, 0, 1));
  assert.throws(() => dijkstra(g, () => NaN, 0, 1));
  const r = dijkstra(g, () => 1, 0, 2);
  assert.equal(r.edges, null);
  assert.equal(r.cost, Infinity);
});

test('Graph rejects edges to missing nodes', () => {
  assert.throws(() => new Graph(2, [{ u: 0, v: 5 }]));
});

test('loop erasure turns a walk with cycles into a simple path', async () => {
  const { eraseLoops } = await import('../js/core/path-aco.js');
  // 0→1→2→1→3 : the cycle 1→2→1 must vanish
  const g = new Graph(4, [{ u: 0, v: 1 }, { u: 1, v: 2 }, { u: 2, v: 1 }, { u: 1, v: 3 }]);
  assert.deepEqual(eraseLoops(g, [0, 1, 2, 3], 0), [0, 3]);
});

test('every ACO ant route is a simple connected s→t path with correct cost', () => {
  const { g, cost, lb } = randomGraph(3);
  const aco = new PathAco(g, cost, lb, { ants: 25 }, 3);
  aco.setEndpoints(0, g.n - 1);
  for (let it = 0; it < 20; it++) {
    const r = aco.step();
    for (const route of r.routes) {
      assert.ok(g.isConnectedPath(route.edges, 0, g.n - 1));
      const nodes = g.nodesOf(route.edges, 0);
      assert.equal(new Set(nodes).size, nodes.length, 'route revisits a node');
      assert.ok(Math.abs(route.cost - g.pathCost(route.edges, cost)) < 1e-9);
    }
  }
  assert.ok(g.isConnectedPath(aco.best.edges, 0, g.n - 1));
});

test('ACO never beats Dijkstra and usually reaches it on small graphs', () => {
  let hits = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const { g, cost, lb } = randomGraph(seed);
    const opt = dijkstra(g, cost, 0, g.n - 1).cost;
    const aco = new PathAco(g, cost, lb, { ants: 20, beta: 3 }, seed);
    aco.setEndpoints(0, g.n - 1);
    for (let i = 0; i < 40; i++) aco.step();
    assert.ok(aco.best.cost >= opt - 1e-9, 'ACO cannot be better than the exact optimum');
    if (aco.best.cost <= opt * 1.0001) hits++;
  }
  assert.ok(hits >= 7, `ACO matched the optimum on ${hits}/10 graphs`);
});

test('path pheromone stays finite/non-negative; evaporation alone decays τ geometrically', () => {
  const { g, cost, lb } = randomGraph(5);
  const aco = new PathAco(g, cost, lb, { ants: 10, rho: 0.3 }, 5);
  aco.setEndpoints(0, g.n - 1);
  for (let i = 0; i < 30; i++) aco.step();
  for (const t of aco.tau) assert.ok(Number.isFinite(t) && t >= 0);
  // an edge never used decays exactly as τ0 (1−ρ)^k
  const untouched = aco.tau.findIndex((_, e) => !aco.touched.has(e));
  assert.ok(untouched >= 0);
  assert.ok(Math.abs(aco.tau[untouched] - aco.tau0 * 0.7 ** 30) < 1e-12 * aco.tau0 + 1e-300);
  // reconstructed history equals live τ
  const someEdge = [...aco.touched][0];
  assert.ok(Math.abs(aco.edgeHistory(someEdge).at(-1).tau - aco.tau[someEdge]) < 1e-9 * aco.tau[someEdge]);
});

test('higher pheromone raises choice probability when α > 0, not when α = 0', () => {
  const { g, cost, lb } = randomGraph(9);
  const aco = new PathAco(g, cost, lb, { alpha: 1, beta: 1 }, 9);
  aco.setEndpoints(0, g.n - 1);
  const before = aco.choiceProbabilities(0);
  const e = before[0].edge;
  aco.tau[e] *= 20;
  const after = aco.choiceProbabilities(0);
  assert.ok(after.find((c) => c.edge === e).p > before[0].p);
  aco.setParams({ alpha: 0 });
  const flat = aco.choiceProbabilities(0);
  assert.ok(Math.abs(flat.find((c) => c.edge === e).p - before[0].p) < 1e-12);
});

test('changing costs (congestion) changes the Dijkstra route and ACO re-prices its best', () => {
  const { g, cost: base, lb } = randomGraph(4);
  const mult = new Float64Array(g.edges.length).fill(1);
  const cost = (ei) => base(ei) * mult[ei];
  const r1 = dijkstra(g, cost, 0, g.n - 1);
  const aco = new PathAco(g, cost, lb, { ants: 20 }, 4);
  aco.setEndpoints(0, g.n - 1);
  for (let i = 0; i < 20; i++) aco.step();
  for (const ei of r1.edges) mult[ei] = 10; // congest the optimal route
  aco.costsChanged('test');
  const r2 = dijkstra(g, cost, 0, g.n - 1);
  assert.notDeepEqual(r2.edges, r1.edges);
  assert.ok(Math.abs(aco.best.cost - g.pathCost(aco.best.edges, cost)) < 1e-9);
  for (let i = 0; i < 40; i++) aco.step();
  assert.ok(aco.best.cost >= r2.cost - 1e-9);
});

test('Tarjan SCC finds components', () => {
  const out = [[0], [1], [2], []];
  const heads = [1, 0, 3];
  const comp = stronglyConnectedComponents(4, out, (k) => heads[k]);
  assert.equal(comp[0], comp[1]);
  assert.notEqual(comp[2], comp[3]);
  assert.notEqual(comp[0], comp[2]);
});

test('haversine: 1° of latitude ≈ 111.2 km', () => {
  assert.ok(Math.abs(haversine(19, 72.8, 20, 72.8) - 111195) < 50);
});

const DATA = new URL('../data/mumbai-roads.json', import.meta.url);
test('bundled Mumbai graph: valid, strongly connected, landmarks snap close, routes connect', { skip: !existsSync(DATA) && 'data not built' }, () => {
  const net = new RoadNetwork(JSON.parse(readFileSync(DATA, 'utf8')));
  assert.ok(net.nodes.length > 500, `only ${net.nodes.length} nodes`);
  for (const [lat, lng] of net.nodes) assert.ok(lat > 18.85 && lat < 19.3 && lng > 72.7 && lng < 73.1);
  for (const s of net.segments) assert.ok(s.length > 0 && s.speed > 0);
  for (const lm of LANDMARKS) {
    const { distance } = net.nearestNode(lm.lat, lm.lng);
    assert.ok(distance < 2500, `${lm.name} snaps ${distance.toFixed(0)} m away`);
  }
  const s = net.nearestNode(19.0596, 72.8295).node; // Bandra West
  const t = net.nearestNode(18.9398, 72.8355).node; // CSMT
  for (const obj of ['distance', 'time']) {
    const r = dijkstra(net.graph, net.costFn(obj), s, t);
    assert.ok(r.edges && net.graph.isConnectedPath(r.edges, s, t));
    const m = net.routeMetrics(r.edges);
    assert.ok(m.distance > 8000 && m.distance < 25000, `distance ${m.distance}`);
    // the objective really is what is optimised
    const other = dijkstra(net.graph, net.costFn(obj === 'time' ? 'distance' : 'time'), s, t);
    const mo = net.routeMetrics(other.edges);
    if (obj === 'time') assert.ok(m.time <= mo.time + 1e-6); else assert.ok(m.distance <= mo.distance + 1e-6);
  }
  // reverse reachability (strong connectivity)
  assert.ok(dijkstra(net.graph, net.costFn('distance'), t, s).edges);
  // ACO on the real graph produces simple connected routes and stays close to the optimum on this pair
  const optT = dijkstra(net.graph, net.costFn('time'), s, t).cost;
  const aco = new PathAco(net.graph, net.costFn('time'), net.heuristicFn('time'), { ants: 15, beta: 1.5 }, 7);
  aco.setEndpoints(s, t);
  for (let i = 0; i < 40; i++) aco.step();
  assert.ok(aco.best && net.graph.isConnectedPath(aco.best.edges, s, t));
  const nodes = net.graph.nodesOf(aco.best.edges, s);
  assert.equal(new Set(nodes).size, nodes.length);
  assert.ok(aco.best.cost >= optT - 1e-6 && aco.best.cost <= optT * 1.25, `ACO ${aco.best.cost} vs opt ${optT}`);
  // congestion changes time costs, not distance
  const d0 = dijkstra(net.graph, net.costFn('distance'), s, t).cost;
  const t0 = dijkstra(net.graph, net.costFn('time'), s, t);
  t0.edges.forEach((ei) => net.setCongestion(net.graph.edges[ei].seg, 8));
  assert.equal(dijkstra(net.graph, net.costFn('distance'), s, t).cost, d0);
  const t1 = dijkstra(net.graph, net.costFn('time'), s, t);
  assert.ok(t1.cost > t0.cost);
  assert.throws(() => net.setCongestion(0, 0.5));
});
