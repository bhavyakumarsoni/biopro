import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateFileSystem, AntivirusAco, riskScore, normaliseWeights, compareSchedulers, STATUS, AV_DEFAULTS,
} from '../js/core/antivirus.js';

const runToCompletion = (eng, cap = 300) => { while (!eng.isComplete() && eng.iteration < cap) eng.step(); return eng; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

test('risk model: weights are normalised and risk stays in [0, 1]', () => {
  const w = normaliseWeights({ sig: 2, beh: 1, attr: 1 });
  assert.ok(Math.abs(w.sig + w.beh + w.attr - 1) < 1e-12);
  assert.equal(riskScore({ sig: 1, beh: 1, attr: 1 }, { sig: 5, beh: 3, attr: 2 }), 1);
  assert.equal(riskScore({ sig: 0, beh: 0, attr: 0 }, AV_DEFAULTS.weights), 0);
});

test('scenarios contain the expected synthetic ground truth', () => {
  const normal = generateFileSystem('normal', 1);
  assert.equal(normal.files.filter((f) => f.truth === 'malicious').length, 0);
  assert.equal(normal.files.filter((f) => f.kind === 'grey').length, 0);
  const sus = generateFileSystem('suspicious', 1);
  assert.equal(sus.files.filter((f) => f.truth === 'malicious').length, 0);
  assert.ok(sus.files.filter((f) => f.kind === 'grey').length > 0);
  const inf = generateFileSystem('infected', 1);
  assert.equal(inf.files.filter((f) => f.truth === 'malicious').length, 3);
  // same seed → identical dataset
  assert.deepEqual(generateFileSystem('infected', 5), generateFileSystem('infected', 5));
});

test('every file has an inspectable state; selection probabilities sum to 1', () => {
  const eng = new AntivirusAco(generateFileSystem('infected', 3), {}, 3);
  eng.step();
  for (const f of eng.files) {
    assert.ok(Object.values(STATUS).includes(f.status));
    assert.ok(Array.isArray(f.reasons) && f.reasons.length > 0);
    assert.ok(Number.isFinite(f.tau));
  }
  const p = eng.fileSelectionProbabilities();
  assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('pheromone stays within MAX–MIN bounds and never NaN', () => {
  const eng = new AntivirusAco(generateFileSystem('infected', 8), { ants: 40 }, 8);
  for (let i = 0; i < 80; i++) eng.step();
  for (const f of eng.files) {
    assert.ok(f.tau >= AV_DEFAULTS.tauMin - 1e-12 && f.tau <= AV_DEFAULTS.tauMax + 1e-12, `${f.name} τ=${f.tau}`);
  }
});

test('never-investigated files keep the neutral baseline τ0', () => {
  const eng = new AntivirusAco(generateFileSystem('normal', 4), { ants: 1 }, 4);
  eng.step();
  for (const f of eng.files) if (f.n === 0) assert.equal(f.tau, AV_DEFAULTS.tau0);
});

test('repeated investigation updates τ by exactly (1−ρ)τ + Δτ (within bounds)', () => {
  const eng = new AntivirusAco(generateFileSystem('infected', 2), { ants: 6 }, 2);
  eng.step();
  const prev = new Map(eng.files.map((f) => [f.id, f.tau]));
  const r = eng.step();
  const dep = new Map();
  for (const e of r.events) dep.set(e.file, (dep.get(e.file) || 0) + e.dTau);
  for (const f of eng.files) {
    if (f.n === 0) continue;
    const expected = Math.min(AV_DEFAULTS.tauMax, Math.max(AV_DEFAULTS.tauMin, (1 - AV_DEFAULTS.rho) * prev.get(f.id) + (dep.get(f.id) || 0)));
    assert.ok(Math.abs(f.tau - expected) < 1e-12, f.name);
  }
});

test('trail strength ordering: malicious > grey > benign (averaged across seeds)', () => {
  const mal = []; const grey = []; const benign = [];
  for (let seed = 1; seed <= 20; seed++) {
    const eng = runToCompletion(new AntivirusAco(generateFileSystem('infected', seed), {}, seed));
    for (const f of eng.files) {
      if (f.status === STATUS.MALICIOUS) mal.push(f.tau);
      else if (f.kind === 'grey') grey.push(f.tau);
      else if (f.kind === 'benign') benign.push(f.tau);
    }
  }
  assert.ok(mean(mal) > mean(grey), `mal ${mean(mal)} grey ${mean(grey)}`);
  assert.ok(mean(grey) > mean(benign), `grey ${mean(grey)} benign ${mean(benign)}`);
});

test('in a normal system every trail ends weak and no file is flagged malicious', () => {
  const eng = runToCompletion(new AntivirusAco(generateFileSystem('normal', 11), {}, 11));
  assert.ok(eng.isComplete());
  assert.equal(eng.metrics().tp + eng.metrics().fp, 0);
  // "weak" display band = below 20 % of τmax (the same band the UI uses)
  for (const f of eng.files) assert.ok(f.tau / AV_DEFAULTS.tauMax < 0.2, `${f.name} τ=${f.tau}`);
});

test('pheromone never classifies: forcing τ high on a benign file does not make it malicious', () => {
  const eng = new AntivirusAco(generateFileSystem('normal', 5), {}, 5);
  for (const f of eng.files) f.tau = AV_DEFAULTS.tauMax;
  runToCompletion(eng);
  assert.equal(eng.files.filter((f) => f.status === STATUS.MALICIOUS).length, 0);
});

test('threshold changes can change classifications without new evidence', () => {
  const eng = runToCompletion(new AntivirusAco(generateFileSystem('infected', 6), {}, 6));
  const before = eng.files.map((f) => f.status).join();
  eng.setParams({ thrSuspicious: 0.05, thrMalicious: 0.1 });
  const after = eng.files.map((f) => f.status).join();
  assert.notEqual(before, after);
});

test('metrics match a manual recount of the confusion matrix', () => {
  for (const seed of [1, 7, 13]) {
    const eng = runToCompletion(new AntivirusAco(generateFileSystem('infected', seed), {}, seed));
    const m = eng.metrics();
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const f of eng.files) {
      const p = f.status === STATUS.MALICIOUS; const t = f.truth === 'malicious';
      if (p && t) tp++; else if (p) fp++; else if (t) fn++; else tn++;
    }
    assert.deepEqual([m.tp, m.fp, m.fn, m.tn], [tp, fp, fn, tn]);
    assert.equal(m.precision, tp + fp ? tp / (tp + fp) : null);
    assert.equal(m.recall, tp + fn ? tp / (tp + fn) : null);
    if (m.precision != null && m.recall != null && m.precision + m.recall > 0) {
      assert.ok(Math.abs(m.f1 - (2 * m.precision * m.recall) / (m.precision + m.recall)) < 1e-12);
    }
  }
});

test('precision/recall are undefined (null) rather than invented when not defined', () => {
  const eng = new AntivirusAco(generateFileSystem('normal', 1), {}, 1);
  const m = eng.metrics();
  assert.equal(m.precision, null);
  assert.equal(m.recall, null);
  assert.equal(m.f1, null);
});

test('injected malware is added with malicious ground truth and is (almost always) confirmed', () => {
  let confirmed = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const eng = new AntivirusAco(generateFileSystem('normal', seed), {}, seed);
    const f = eng.injectMalware();
    assert.equal(f.truth, 'malicious');
    assert.equal(f.status, STATUS.PENDING);
    runToCompletion(eng);
    const st = eng.files[f.id].status;
    assert.notEqual(st, STATUS.CLEAN, `seed ${seed}: injected sample cleared`);
    if (st === STATUS.MALICIOUS) confirmed++;
  }
  assert.ok(confirmed >= 16, `confirmed ${confirmed}/20`);
});

test('scheduler comparison is reproducible and reports both arms honestly', () => {
  const ds = generateFileSystem('infected', 4);
  const a = compareSchedulers(ds, {}, 4);
  const b = compareSchedulers(ds, {}, 4);
  assert.deepEqual(a, b);
  for (const arm of [a.aco, a.uniform]) {
    assert.ok(arm.evaluations > 0 && Number.isFinite(arm.cost));
    assert.ok(Math.abs(arm.coverageCost + arm.monitorCost - arm.cost) < 1e-9);
  }
});
