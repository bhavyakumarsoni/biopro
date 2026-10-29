// ACO-inspired investigation prioritiser for a SYNTHETIC file system.
// Educational simulation — not a production antivirus engine. Real malware does not emit
// "pheromones"; pheromone here is a computational priority signal used by the scheduler.
//
// Separation of concerns (each is a different quantity):
//   1. Evidence      – noisy observations produced by the (simulated) scanning engine.
//   2. Risk estimate – R̂ = w1·sig + w2·beh + w3·attr  (weights normalised to sum to 1).
//   3. Pheromone τ   – optimisation signal that decides WHERE ants look next.
//   4. Classification– decision rules on R̂ and its uncertainty ONLY. τ never classifies a file.
//
// Per-iteration:
//   a) each ant chooses a directory, then a file:  P ∝ τ^α · η^β  (η = cheap static-triage prior)
//   b) the engine evaluates each selected file → one noisy evidence observation
//   c) Δτ(file) = Q · (ε + R̂(file)) · C(n)     C(n) = n/(n+κ)  (evidence confidence)
//   d) τ ← clamp((1 − ρ)·τ + Σ Δτ, τmin, τmax)    (MAX–MIN bounds keep τ finite and every file reachable)
//   e) classification with a one-sided confidence margin m(n) = z·σ_R/√n, σ_R = σ·‖w‖₂.
// Files confirmed CLEAN leave the Allowed set (they are resolved, like visited nodes in a tour);
// suspicious and malicious files stay eligible so evidence keeps accumulating on them.

import { createRng, rouletteSelect } from './rng.js';

export const AV_DEFAULTS = Object.freeze({
  ants: 8,
  alpha: 1,
  beta: 2,
  rho: 0.05,
  Q: 1,
  epsilon: 0.05, // baseline deposit so ordinary files still leave a faint trail
  kappa: 2, // evidence-confidence half-saturation: C(n) = n / (n + κ)
  tau0: 0.2, // neutral baseline for never-investigated files
  tauMin: 0.05, // MAX–MIN bounds keep τ finite and every eligible file reachable
  tauMax: 6,
  weights: { sig: 0.45, beh: 0.35, attr: 0.2 },
  thrSuspicious: 0.35,
  thrMalicious: 0.6,
  z: 1.645, // one-sided 95 % margin
  noise: 0.2, // σ of the noise on each observed feature
  maxInvestigations: 5, // evidence budget per file
  monitorThreats: true, // confirmed threats stay eligible (re-verification scans)
})

export const STATUS = Object.freeze({
  PENDING: 'pending',
  SCANNING: 'scanning',
  CLEAN: 'clean',
  SUSPICIOUS: 'suspicious',
  MALICIOUS: 'malicious',
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v) => clamp(v, 0, 1);

export function normaliseWeights(w) {
  const s = Math.max(1e-12, (w.sig || 0) + (w.beh || 0) + (w.attr || 0));
  return { sig: (w.sig || 0) / s, beh: (w.beh || 0) / s, attr: (w.attr || 0) / s };
}

export function riskScore(f, weights) {
  const w = normaliseWeights(weights);
  return clamp01(w.sig * f.sig + w.beh * f.beh + w.attr * f.attr);
}

// ---------------------------------------------------------------------------
// Synthetic dataset
// ---------------------------------------------------------------------------
const DIRS = [
  { name: 'C:/Windows/System32', files: ['kernel32.dll', 'ntdll.dll', 'user32.dll', 'svchost.exe', 'drivers.cfg', 'winlogon.exe', 'audio.sys', 'netio.sys', 'shell32.dll', 'crypt32.dll'] },
  { name: 'C:/Program Files', files: ['chrome.exe', 'vlc.exe', 'office_setup.msi', 'python.exe', 'git.exe', 'zoom.exe', 'node.exe', 'matlab.exe', 'spotify.exe'] },
  { name: 'C:/Users/Docs', files: ['report.docx', 'marks.xlsx', 'thesis.pdf', 'notes.txt', 'budget.xlsx', 'photo.jpg', 'macro_sheet.xlsm', 'lab_manual.pdf', 'resume.docx', 'slides.pptx'] },
  { name: 'C:/Users/Downloads', files: ['installer.exe', 'free_game.zip', 'keygen_tool.exe', 'driver_update.exe', 'invoice_pdf.exe', 'movie.mp4', 'song.mp3', 'crack_patch.exe', 'syllabus.pdf'] },
  { name: 'C:/Temp', files: ['tmp4f2a.dat', 'cache01.bin', 'update.ps1', 'setup_log.txt', 'svch0st.exe', 'debug.dmp', 'tmp91c0.tmp', 'helper.vbs'] },
];

// Static triage prior (cheap metadata only: extension + location). This is η — the heuristic
// visibility. It is NOT the risk score and is available before any deep scan.
const EXT_PRIOR = { tmp: 0.3, vbs: 0.6, mp3: 0.05, pptx: 0.1, exe: 0.55, dll: 0.35, msi: 0.45, ps1: 0.6, zip: 0.4, xlsm: 0.5, sys: 0.35, bin: 0.35, dat: 0.3, cfg: 0.15, dmp: 0.15, docx: 0.12, xlsx: 0.12, pdf: 0.15, txt: 0.08, jpg: 0.06, mp4: 0.06 };
const DIR_PRIOR = { 'C:/Windows/System32': 0.3, 'C:/Program Files': 0.2, 'C:/Users/Docs': 0.15, 'C:/Users/Downloads': 0.5, 'C:/Temp': 0.55 };

function ext(name) { return name.split('.').pop().toLowerCase(); }

function featuresFor(kind, rng) {
  switch (kind) {
    case 'malware': // known-signature malware
      return { sig: rng.range(0.7, 0.95), beh: rng.range(0.6, 0.9), attr: rng.range(0.55, 0.9) };
    case 'zeroday': // novel malware: no signature, strong behaviour
      return { sig: rng.range(0.02, 0.12), beh: rng.range(0.75, 0.95), attr: rng.range(0.65, 0.9) };
    case 'grey': // benign but unusual (unsigned installer, macro sheet, packed tool)
      return { sig: rng.range(0.03, 0.15), beh: rng.range(0.3, 0.55), attr: rng.range(0.45, 0.8) };
    default:
      return { sig: rng.range(0, 0.06), beh: rng.range(0.02, 0.2), attr: rng.range(0, 0.3) };
  }
}

/**
 * Scenarios:
 *  normal     – all benign, ordinary features
 *  suspicious – all benign, several "grey" files (tests false positives)
 *  infected   – grey files + 2 known malware + 1 zero-day-like sample
 */
export function generateFileSystem(scenario = 'infected', seed = 1) {
  const rng = createRng(seed);
  const files = [];
  const dirs = DIRS.map((d, di) => ({ id: di, name: d.name, prior: DIR_PRIOR[d.name] }));
  for (const [di, d] of DIRS.entries()) {
    for (const name of d.files) {
      files.push({ name, dir: di, kind: 'benign' });
    }
  }
  const pickBy = (pred, k) => rng.shuffle(files.filter(pred)).slice(0, k);
  if (scenario === 'suspicious' || scenario === 'infected') {
    const greyPool = ['office_setup.msi', 'installer.exe', 'driver_update.exe', 'macro_sheet.xlsm', 'update.ps1', 'free_game.zip', 'git.exe', 'cache01.bin', 'node.exe', 'tmp91c0.tmp'];
    for (const f of pickBy((f) => greyPool.includes(f.name), scenario === 'suspicious' ? 5 : 3)) f.kind = 'grey';
  }
  if (scenario === 'infected') {
    const malPool = ['keygen_tool.exe', 'invoice_pdf.exe', 'svch0st.exe', 'tmp4f2a.dat', 'crack_patch.exe', 'helper.vbs'];
    const [m1, m2, m3] = pickBy((f) => malPool.includes(f.name) && f.kind === 'benign', 3);
    if (m1) m1.kind = 'malware';
    if (m2) m2.kind = 'malware';
    if (m3) m3.kind = 'zeroday';
  }
  files.forEach((f, i) => {
    f.id = i;
    f.ext = ext(f.name);
    f.sizeKB = Math.round(rng.range(8, f.ext === 'mp4' ? 900000 : 60000));
    f.truth = f.kind === 'malware' || f.kind === 'zeroday' ? 'malicious' : 'benign';
    f.features = featuresFor(f.kind, rng);
    f.prior = clamp01(0.5 * (EXT_PRIOR[f.ext] ?? 0.2) + 0.5 * dirs[f.dir].prior);
  });
  return { scenario, seed, dirs, files };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
export class AntivirusAco {
  constructor(dataset, params = {}, seed = 1) {
    this.params = { ...AV_DEFAULTS, ...params, weights: { ...AV_DEFAULTS.weights, ...(params.weights || {}) } };
    this.load(dataset, seed);
  }

  setParams(p) {
    const weights = p.weights ? { ...this.params.weights, ...p.weights } : this.params.weights;
    this.params = { ...this.params, ...p, weights };
    this.params.ants = Math.round(clamp(Number(this.params.ants) || 1, 1, 200));
    this.params.rho = clamp(Number(this.params.rho), 0.001, 0.999);
    this.params.thrSuspicious = clamp01(Number(this.params.thrSuspicious));
    this.params.thrMalicious = clamp(Number(this.params.thrMalicious), this.params.thrSuspicious, 1);
    this.params.maxInvestigations = Math.round(clamp(Number(this.params.maxInvestigations) || 8, 1, 100));
    // Classification rules depend on thresholds → re-evaluate immediately (no new evidence needed).
    if (this.files) for (const f of this.files) this.classify(f);
  }

  load(dataset, seed = 1) {
    this.dataset = dataset;
    this.dirs = dataset.dirs.map((d) => ({ ...d }));
    this.files = dataset.files.map((f) => this.makeFileState(f));
    this.seed = seed;
    this.rng = createRng(seed ^ 0x5a5a5a5a);
    this.iteration = 0;
    this.evaluations = 0;
    this.costUnits = 0;
    this.monitorEvaluations = 0;
    this.monitorCost = 0;
    this.lastPlan = null;
    this.firstDetection = null;
  }

  makeFileState(f) {
    return {
      ...f,
      features: { ...f.features },
      trueRisk: riskScore(f.features, this.params.weights),
      n: 0,
      sum: { sig: 0, beh: 0, attr: 0 },
      est: null, // estimated features (mean of observations)
      riskHat: null,
      margin: null,
      status: STATUS.PENDING,
      resolved: false,
      reasons: ['Not yet investigated by any ant.'],
      tau: this.params.tau0, // neutral baseline until first investigation
      tauHistory: [],
      depositsLast: 0,
      antsLast: 0,
      firstScanIt: null,
      classifiedIt: null,
    };
  }

  /**
   * η (visibility): static-triage prior × remaining uncertainty, η = prior · (1 − C(n)).
   * A never-investigated file has η = prior; η shrinks as evidence about the file accumulates,
   * so ants are drawn to files where one more investigation is most informative.
   */
  eta(file) { return Math.max(1e-4, file.prior * (1 - this.confidence(file.n))); }

  /**
   * Allowed set: files without a final verdict (resolved files are like visited nodes),
   * plus confirmed-malicious files, which stay under monitoring when `monitorThreats` is on.
   */
  isAllowed(f) { return !f.resolved || (this.params.monitorThreats && f.status === STATUS.MALICIOUS); }

  /** P(ant investigates file) = τ^α η^β / Σ_{Allowed} τ^α η^β  (0 for files outside Allowed). */
  fileSelectionProbabilities() {
    const { alpha, beta } = this.params;
    const out = new Array(this.files.length).fill(0);
    const allowed = this.files.filter((f) => this.isAllowed(f));
    if (!allowed.length) return out;
    const lw = allowed.map((f) => alpha * Math.log(Math.max(f.tau, 1e-300)) + beta * Math.log(this.eta(f)));
    const mx = Math.max(...lw);
    const w = lw.map((v) => Math.exp(v - mx));
    const s = w.reduce((x, y) => x + y, 0);
    allowed.forEach((f, k) => { out[f.id] = w[k] / s; });
    return out;
  }

  /**
   * Phase 1: each ant selects a candidate file (path root → directory → file).
   * Within one iteration ants pick distinct files (colony-level tabu list), so one file can
   * receive at most one investigation per iteration; surplus ants stay idle.
   */
  plan() {
    const probs = this.fileSelectionProbabilities();
    const picks = [];
    const avail = probs.slice();
    for (let a = 0; a < this.params.ants; a++) {
      if (!avail.some((v) => v > 0)) break;
      const id = rouletteSelect(avail, this.rng);
      picks.push({ ant: a, dir: this.files[id].dir, file: id, p: probs[id] });
      avail[id] = 0;
    }
    this.lastPlan = { iteration: this.iteration + 1, picks, probs };
    return this.lastPlan;
  }

  /** Scan is complete when every file has a final verdict. */
  isComplete() { return this.files.every((f) => f.resolved); }

  /** Simulated engine: one noisy observation of a file's evidence. */
  observe(file) {
    const s = this.params.noise;
    const f = file.features;
    return {
      sig: clamp01(f.sig + this.rng.normal() * s),
      beh: clamp01(f.beh + this.rng.normal() * s),
      attr: clamp01(f.attr + this.rng.normal() * s),
    };
  }

  confidence(n) { return n / (n + this.params.kappa); }

  classify(f) {
    const p = this.params;
    const prev = f.status;
    if (f.n === 0) {
      f.status = STATUS.PENDING;
      f.resolved = false;
      f.reasons = ['Not yet investigated by any ant.'];
      return prev !== f.status;
    }
    f.est = { sig: f.sum.sig / f.n, beh: f.sum.beh / f.n, attr: f.sum.attr / f.n };
    f.riskHat = riskScore(f.est, p.weights);
    const w = normaliseWeights(p.weights);
    const sigmaR = p.noise * Math.hypot(w.sig, w.beh, w.attr);
    f.margin = (p.z * sigmaR) / Math.sqrt(f.n);
    const lo = f.riskHat - f.margin;
    const hi = f.riskHat + f.margin;
    const r = (v) => v.toFixed(3);
    if (lo >= p.thrMalicious) {
      f.status = STATUS.MALICIOUS;
      f.resolved = true;
      f.reasons = [`Lower confidence bound R̂−m = ${r(lo)} ≥ malicious threshold ${r(p.thrMalicious)}.`];
    } else if (hi < p.thrSuspicious) {
      f.status = STATUS.CLEAN;
      f.resolved = true;
      f.reasons = [`Upper confidence bound R̂+m = ${r(hi)} < suspicious threshold ${r(p.thrSuspicious)}.`];
    } else if (f.riskHat >= p.thrSuspicious) {
      f.status = STATUS.SUSPICIOUS;
      f.reasons = [`Estimate R̂ = ${r(f.riskHat)} ≥ suspicious threshold ${r(p.thrSuspicious)}.`];
      // Final "flag for review" verdict once the interval can no longer reach the malicious threshold.
      f.resolved = hi < p.thrMalicious;
      if (f.riskHat >= p.thrMalicious) f.reasons.push(`R̂ exceeds the malicious threshold but the margin m = ${r(f.margin)} (n = ${f.n}) is too wide to confirm; more investigations needed.`);
      else if (f.resolved) f.reasons.push(`Final: R̂+m = ${r(hi)} < malicious threshold ${r(p.thrMalicious)}, so it cannot be confirmed malicious — flagged for analyst review.`);
      else f.reasons.push(`Not yet confirmed either way: R̂+m = ${r(hi)} still reaches the malicious threshold ${r(p.thrMalicious)}.`);
    } else {
      f.status = STATUS.SCANNING;
      f.resolved = false;
      f.reasons = [`Inconclusive: R̂ = ${r(f.riskHat)} is below ${r(p.thrSuspicious)}, but R̂+m = ${r(hi)} still overlaps it. Needs more evidence.`];
    }
    if (!f.resolved && f.n >= p.maxInvestigations) {
      // Evidence budget exhausted: decide on the point estimate, never escalating to "malicious".
      f.resolved = true;
      f.status = f.riskHat >= p.thrSuspicious ? STATUS.SUSPICIOUS : STATUS.CLEAN;
      f.reasons = [`Evidence budget reached (n = ${f.n}). Final verdict from point estimate R̂ = ${r(f.riskHat)} ` +
        (f.status === STATUS.SUSPICIOUS ? `≥ ${r(p.thrSuspicious)} → flagged for analyst review (not confirmed malicious).` : `< ${r(p.thrSuspicious)} → clean.`)];
    }
    const top = Object.entries(f.est).sort((a, b) => b[1] * p.weights[b[0]] - a[1] * p.weights[a[0]])[0];
    const label = { sig: 'signature match', beh: 'behavioural anomaly', attr: 'suspicious attributes' }[top[0]];
    f.reasons.push(`Largest weighted contributor: ${label} (${r(top[1])} × w=${r(normaliseWeights(p.weights)[top[0]])}).`);
    f.reasons.push('Pheromone does not enter this decision — it only changes how often the file is investigated.');
    return prev !== f.status;
  }

  /** Phases 2–6 for a plan produced by plan(). */
  commit(plan = this.lastPlan) {
    if (!plan) plan = this.plan();
    const p = this.params;
    this.iteration = plan.iteration;
    const events = [];
    const deposit = new Map();
    const antsOn = new Map();
    for (const pick of plan.picks) {
      const f = this.files[pick.file];
      const monitoring = f.status === STATUS.MALICIOUS;
      const obs = this.observe(f);
      f.n++;
      f.sum.sig += obs.sig; f.sum.beh += obs.beh; f.sum.attr += obs.attr;
      if (f.firstScanIt == null) f.firstScanIt = this.iteration;
      this.evaluations++;
      const unit = 1 + f.sizeKB / 51200; // simulated: 1 unit + 1 per 50 MB scanned
      this.costUnits += unit;
      if (monitoring) { this.monitorEvaluations++; this.monitorCost += unit; }
      const prevStatus = f.status;
      const changed = this.classify(f);
      const dTau = p.Q * (p.epsilon + f.riskHat) * this.confidence(f.n);
      deposit.set(f.id, (deposit.get(f.id) || 0) + dTau);
      antsOn.set(f.id, (antsOn.get(f.id) || 0) + 1);
      events.push({ ant: pick.ant, file: f.id, obs, riskHat: f.riskHat, dTau, status: f.status, changed, prevStatus, monitoring });
    }
    // Evaporation + deposit with MAX–MIN bounds. Never-investigated files hold the neutral τ0.
    for (const f of this.files) {
      const d = deposit.get(f.id) || 0;
      f.depositsLast = d;
      f.antsLast = antsOn.get(f.id) || 0;
      if (f.n > 0) f.tau = clamp((1 - p.rho) * f.tau + d, p.tauMin, p.tauMax);
      f.tauHistory.push({ it: this.iteration, tau: f.tau, dep: d });
      if (f.tauHistory.length > 300) f.tauHistory.shift();
    }
    for (const e of events) {
      const f = this.files[e.file];
      if (e.changed) {
        if (f.status === STATUS.MALICIOUS || f.status === STATUS.CLEAN) f.classifiedIt = this.iteration;
        if (f.status === STATUS.MALICIOUS && !this.firstDetection) {
          this.firstDetection = { iteration: this.iteration, evaluations: this.evaluations, cost: this.costUnits, file: f.id };
        }
      }
    }
    return { iteration: this.iteration, events };
  }

  step() { return this.commit(this.plan()); }

  /** Inject a known-signature sample into Downloads (ground truth: malicious). */
  injectMalware(name) {
    const di = this.dirs.findIndex((d) => d.name.endsWith('Downloads'));
    const id = this.files.length;
    const features = featuresFor('malware', this.rng);
    const f = {
      id, name: name || `payload_${(id * 7919) % 1000}.exe`, dir: di, kind: 'malware', ext: 'exe',
      sizeKB: Math.round(this.rng.range(200, 4000)), truth: 'malicious', features,
      prior: clamp01(0.5 * EXT_PRIOR.exe + 0.5 * this.dirs[di].prior),
    };
    const st = this.makeFileState(f);
    this.files.push(st);
    return st;
  }

  /** Confusion matrix against synthetic ground truth. Positive = classified MALICIOUS. */
  metrics() {
    let tp = 0, fp = 0, fn = 0, tn = 0, scanned = 0, flagged = 0;
    for (const f of this.files) {
      if (f.n > 0) scanned++;
      if (f.status === STATUS.SUSPICIOUS) flagged++;
      const pred = f.status === STATUS.MALICIOUS;
      const truth = f.truth === 'malicious';
      if (pred && truth) tp++;
      else if (pred && !truth) fp++;
      else if (!pred && truth) fn++;
      else tn++;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : null;
    const recall = tp + fn > 0 ? tp / (tp + fn) : null;
    const f1 = precision != null && recall != null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
    return {
      tp, fp, fn, tn, scanned, total: this.files.length, flagged, precision, recall, f1,
      evaluations: this.evaluations, costUnits: this.costUnits,
      monitorEvaluations: this.monitorEvaluations, monitorCost: this.monitorCost,
    };
  }
}

/**
 * Honest baseline comparison on the SAME synthetic dataset, seed and noise model:
 * the ACO scheduler vs. a uniform-random scheduler (α = β = 0, same Allowed-set rule).
 * Reports simulated cost units until (a) the first confirmed detection and (b) every file
 * has a final verdict. Cost units are a simulation quantity, not measured CPU time.
 */
export function compareSchedulers(dataset, params, seed, maxIterations = 300) {
  const run = (overrides) => {
    const eng = new AntivirusAco(dataset, { ...params, ...overrides }, seed);
    let first = null;
    while (eng.iteration < maxIterations && !eng.isComplete()) {
      eng.step();
      if (!first && eng.firstDetection) first = { ...eng.firstDetection };
    }
    const m = eng.metrics();
    return {
      complete: eng.isComplete(), iteration: eng.iteration, evaluations: eng.evaluations, cost: eng.costUnits,
      monitorCost: eng.monitorCost, coverageCost: eng.costUnits - eng.monitorCost, first, tp: m.tp, fp: m.fp, fn: m.fn,
    };
  };
  return { aco: run({}), uniform: run({ alpha: 0, beta: 0 }) };
}
