import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng, rouletteSelect } from '../js/core/rng.js';
import {
  TspAntSystem, makePreset, heldKarp, distanceMatrix, tourLength, isValidTour, circleOptimum, nearestNeighbourTour,
} from '../js/core/tsp-aco.js';

const rngNodes = (seed, n = 10) => makePreset('random', createRng(seed), n);

test('rng is deterministic for a given seed', () => {
  const a = createRng(42); const b = createRng(42);
  for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
  assert.notEqual(createRng(1).next(), createRng(2).next());
});

test('roulette selection follows the weights and never picks zero-weight items', () => {
  const rng = createRng(7);
  const counts = [0, 0, 0];
  for (let i = 0; i < 20000; i++) counts[rouletteSelect([1, 0, 3], rng)]++;
  assert.equal(counts[1], 0);
  const ratio = counts[2] / counts[0];
  assert.ok(ratio > 2.7 && ratio < 3.3, `ratio ${ratio}`);
  assert.equal(rouletteSelect([], rng), -1);
  // all-zero weights fall back to a uniform pick instead of failing
  const k = rouletteSelect([0, 0], rng);
  assert.ok(k === 0 || k === 1);
});

test('every ant tour is a valid permutation and tour lengths are recomputable', () => {
  const aco = new TspAntSystem(rngNodes(3, 12), { ants: 20 }, 3);
  for (let it = 0; it < 15; it++) {
    const r = aco.step();
    for (const { tour, length } of r.tours) {
      assert.ok(isValidTour(tour, 12));
      assert.ok(Math.abs(length - tourLength(tour, aco.dist)) < 1e-9);
    }
  }
  assert.ok(isValidTour(aco.best.tour, 12));
});

test('pheromone stays finite and non-negative over long runs with extreme parameters', () => {
  for (const params of [{ alpha: 5, beta: 15, rho: 0.01 }, { alpha: 0, beta: 0, rho: 0.999 }, { alpha: 10, beta: 0, rho: 0.5 }]) {
    const aco = new TspAntSystem(rngNodes(5, 14), { ...params, ants: 15 }, 5);
    for (let it = 0; it < 60; it++) aco.step();
    for (let i = 0; i < aco.n; i++) {
      for (let j = 0; j < aco.n; j++) {
        if (i === j) continue;
        assert.ok(Number.isFinite(aco.tau[i][j]) && aco.tau[i][j] >= 0, `τ[${i}][${j}] = ${aco.tau[i][j]}`);
      }
    }
  }
});

test('evaporation alone decreases pheromone geometrically by (1 − ρ)', () => {
  const aco = new TspAntSystem(rngNodes(9, 8), { rho: 0.2, ants: 1 }, 9);
  const before = aco.tau[0][1];
  // isolate evaporation: an ant with Q → tiny contributes ~nothing
  aco.setParams({ Q: 1e-6 });
  aco.step();
  const after = aco.tau[0][1];
  assert.ok(after < before);
  assert.ok(Math.abs(after - before * 0.8) < 1e-5 * before + 1e-6);
});

test('transition probabilities sum to 1, exclude visited nodes, and respond to α', () => {
  const aco = new TspAntSystem(rngNodes(11, 9), { alpha: 1, beta: 0 }, 11);
  const visited = new Uint8Array(9); visited[0] = 1; visited[3] = 1;
  let probs = aco.transitionProbabilities(0, visited);
  assert.ok(probs.every((c) => c.j !== 3 && c.j !== 0));
  assert.ok(Math.abs(probs.reduce((a, c) => a + c.p, 0) - 1) < 1e-12);
  // with β = 0 and uniform τ, all choices are equally likely
  const p0 = probs[0].p;
  assert.ok(probs.every((c) => Math.abs(c.p - p0) < 1e-12));
  // raise τ on one edge: with α > 0 its probability rises
  aco.tau[0][5] *= 10; aco.tau[5][0] *= 10;
  probs = aco.transitionProbabilities(0, visited);
  const p5 = probs.find((c) => c.j === 5).p;
  assert.ok(p5 > p0 * 3, `p5 ${p5} vs ${p0}`);
  // with α = 0 the pheromone has no effect
  aco.setParams({ alpha: 0 });
  probs = aco.transitionProbabilities(0, visited);
  assert.ok(Math.abs(probs.find((c) => c.j === 5).p - p0) < 1e-12);
});

test('β > 0 makes nearer nodes more likely', () => {
  const aco = new TspAntSystem(rngNodes(4, 10), { alpha: 0, beta: 4 }, 4);
  const probs = aco.transitionProbabilities(0);
  const nearest = probs.reduce((a, c) => (aco.dist[0][c.j] < aco.dist[0][a.j] ? c : a));
  assert.equal(Math.max(...probs.map((c) => c.p)), nearest.p);
});

test('Held–Karp is exact on the circle preset (polygon perimeter) and bounds NN', () => {
  const nodes = makePreset('circle', createRng(1), 10);
  const hk = heldKarp(distanceMatrix(nodes));
  assert.ok(Math.abs(hk.length - circleOptimum(nodes)) < 1e-6);
  const nodes2 = rngNodes(8, 11);
  const d = distanceMatrix(nodes2);
  const hk2 = heldKarp(d);
  assert.ok(isValidTour(hk2.tour, 11));
  assert.ok(Math.abs(tourLength(hk2.tour, d) - hk2.length) < 1e-6);
  assert.ok(hk2.length <= tourLength(nearestNeighbourTour(d), d) + 1e-9);
  assert.equal(heldKarp(distanceMatrix(rngNodes(1, 20))), null);
});

test('ACO converges near the exact optimum on a 10-city instance (stochastic, not guaranteed)', () => {
  const nodes = rngNodes(21, 10);
  const opt = heldKarp(distanceMatrix(nodes)).length;
  const aco = new TspAntSystem(nodes, { ants: 20, alpha: 1, beta: 3, rho: 0.1 }, 21);
  for (let i = 0; i < 80; i++) aco.step();
  assert.ok(aco.best.length <= opt * 1.05, `ACO ${aco.best.length} vs opt ${opt}`);
  // best-so-far history is monotonically non-increasing
  const h = aco.history.best;
  for (let i = 1; i < h.length; i++) assert.ok(h[i] <= h[i - 1] + 1e-9);
});

test('reset restores τ0 and clears history; same seed reproduces the same run', () => {
  const nodes = rngNodes(2, 9);
  const a = new TspAntSystem(nodes, {}, 99);
  for (let i = 0; i < 10; i++) a.step();
  const firstRun = a.history.best.slice();
  a.reset(99);
  assert.equal(a.iteration, 0);
  assert.equal(a.best, null);
  assert.equal(a.history.best.length, 0);
  assert.ok(Math.abs(a.tau[0][1] - a.tau0) < 1e-15);
  for (let i = 0; i < 10; i++) a.step();
  assert.deepEqual(a.history.best, firstRun);
});

test('parameter changes affect the real algorithm (ρ changes τ trajectory)', () => {
  const nodes = rngNodes(6, 9);
  const a = new TspAntSystem(nodes, { rho: 0.05 }, 6);
  const b = new TspAntSystem(nodes, { rho: 0.6 }, 6);
  for (let i = 0; i < 5; i++) { a.step(); b.step(); }
  assert.notEqual(a.maxTau(), b.maxTau());
  const c = new TspAntSystem(nodes, { ants: 5 }, 6);
  c.step();
  assert.equal(c.lastIteration.tours.length, 5);
});

test('invalid parameters are sanitised, never produce NaN', () => {
  const aco = new TspAntSystem(rngNodes(3, 6), { alpha: 'abc', beta: -5, rho: 7, ants: 0 }, 3);
  assert.ok(Number.isFinite(aco.params.alpha));
  assert.ok(aco.params.beta >= 0 && aco.params.rho < 1 && aco.params.ants >= 1);
  aco.step();
  assert.ok(Number.isFinite(aco.best.length));
  // fewer than 3 nodes: step is a no-op, not a crash
  const tiny = new TspAntSystem([{ x: 0, y: 0 }, { x: 1, y: 1 }], {}, 1);
  assert.equal(tiny.step(), null);
});

test('edge info exposes τ, distance and per-iteration history', () => {
  const aco = new TspAntSystem(rngNodes(12, 7), {}, 12);
  for (let i = 0; i < 4; i++) aco.step();
  const e = aco.edgeInfo(2, 0);
  assert.equal(e.i, 0); assert.equal(e.j, 2);
  assert.equal(e.history.length, 4);
  assert.equal(e.history.at(-1).tau, aco.tau[0][2]);
  assert.ok(e.distance > 0);
});
