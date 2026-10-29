// Lab 2 — UI controller for the ACO-inspired antivirus prioritiser.
// One iteration is animated as 7 phases. Drawing uses a snapshot of the state *before* the
// engine commits, then switches to the committed state, so the picture never runs ahead of
// (or diverges from) the algorithm.

import { randomSeed } from '../core/rng.js';
import { generateFileSystem, AntivirusAco, compareSchedulers, STATUS, AV_DEFAULTS, normaliseWeights } from '../core/antivirus.js';
import { $, fmt, bindRange, bindSeg, setPill, fitCanvas, drawSparkline, Runner, escapeHtml } from './util.js';

const COLORS = { pending: '#6b7280', scanning: '#60a5fa', clean: '#34d399', suspicious: '#f59e0b', malicious: '#f43f5e' };
const STATUS_LABEL = { pending: 'pending', scanning: 'inconclusive', clean: 'clean', suspicious: 'suspicious', malicious: 'malicious' };
// Phase durations (ms) at speed 1; divided by the speed factor.
const PHASE_MS = [0, 1500, 650, 450, 1600, 600, 450, 1100];
const SPEED_FACTOR = [0, 0.5, 1, 1.8, 3.2, 6];
const PHASE_NAMES = ['', 'Ants leave the nest', 'Ants inspect files', 'Evidence measured', 'Ants return, laying pheromone', 'Trails evaporate & rank', 'Evidence check', 'Strongest trails → threats'];

/**
 * Displayed trail intensity: (τ / τmax)^0.6 — monotonic in the real pheromone value, with a mild
 * gamma so faint trails stay visible while the strongest trails clearly stand out.
 */
export function trailLevel(tau, p = AV_DEFAULTS) {
  return Math.max(0, Math.min(1, Math.pow(Math.max(0, tau) / p.tauMax, 0.6)));
}

export function initAvLab() {
  const canvas = $('#av-canvas');
  const statusEl = $('#av-status');
  const startBtn = $('#av-start');
  const logEl = $('#av-log');

  const st = {
    scenario: 'infected',
    seed: 42,
    speed: 3,
    selected: null,
    phase: 0, // 0 idle, 1..7 animation phase
    phaseStart: 0,
    plan: null,
    commitResult: null,
    snapshot: null, // {tau:[], status:[], riskHat:[]} before commit
    running: false,
    complete: false,
    newlyMalicious: new Set(),
    hover: null,
  };
  const params = { ants: 8, rho: 0.05, alpha: 1, beta: 2, thrSuspicious: 0.35, thrMalicious: 0.6, maxInvestigations: 5 };
  let eng = null;

  // ------------------------------------------------------------- controls
  bindRange($('#av-speed'), $('#av-speed-v'), (v) => { st.speed = v; }, (v) => ['', 'slow', 'calm', 'normal', 'fast', 'turbo'][v]);
  const setAnts = bindRange($('#av-ants'), $('#av-ants-v'), (v) => { params.ants = v; eng?.setParams({ ants: v }); renderPanels(); }, String);
  const setRho = bindRange($('#av-rho'), $('#av-rho-v'), (v) => { params.rho = v; eng?.setParams({ rho: v }); }, (v) => v.toFixed(2));
  bindRange($('#av-alpha'), $('#av-alpha-v'), (v) => { params.alpha = v; eng?.setParams({ alpha: v }); renderPanels(); }, (v) => v.toFixed(1));
  bindRange($('#av-beta'), $('#av-beta-v'), (v) => { params.beta = v; eng?.setParams({ beta: v }); renderPanels(); }, (v) => v.toFixed(1));
  const thrS = $('#av-thr-s'); const thrM = $('#av-thr-m');
  const onThreshold = () => {
    let s = Number(thrS.value); let m = Number(thrM.value);
    if (m < s + 0.02) { m = Math.min(0.98, s + 0.02); thrM.value = m; }
    params.thrSuspicious = s; params.thrMalicious = Number(thrM.value);
    $('#av-thr-s-v').textContent = s.toFixed(2);
    $('#av-thr-m-v').textContent = params.thrMalicious.toFixed(2);
    if (eng) {
      const before = eng.files.map((f) => f.status);
      eng.setParams({ thrSuspicious: s, thrMalicious: params.thrMalicious });
      const changed = eng.files.filter((f, i) => f.status !== before[i]);
      if (changed.length) log(`thresholds θs=${s.toFixed(2)}, θm=${params.thrMalicious.toFixed(2)} → ${changed.length} file(s) re-classified from existing evidence`, 'info');
      st.complete = eng.isComplete();
      renderAll();
    }
  };
  thrS.addEventListener('input', onThreshold);
  thrM.addEventListener('input', onThreshold);
  $('#av-thr-s-v').textContent = Number(thrS.value).toFixed(2);
  $('#av-thr-m-v').textContent = Number(thrM.value).toFixed(2);
  bindRange($('#av-budget'), $('#av-budget-v'), (v) => {
    params.maxInvestigations = v;
    if (eng) { eng.setParams({ maxInvestigations: v }); st.complete = eng.isComplete(); renderAll(); }
  }, String);
  const settingsBtn = $('#av-settings-btn');
  settingsBtn.addEventListener('click', () => {
    const open = $('#av-settings').hidden;
    $('#av-settings').hidden = !open;
    settingsBtn.setAttribute('aria-expanded', String(open));
  });
  $('#av-side-back').addEventListener('click', () => { st.selected = null; renderAll(); });
  const scenarioSeg = bindSeg($('#av-scenario'), (v) => { st.scenario = v; load(); });
  const seedInput = $('#av-seed');
  seedInput.addEventListener('change', () => {
    const v = Math.floor(Number(seedInput.value));
    if (!(v >= 1 && v <= 999999999)) { seedInput.value = st.seed; return; }
    st.seed = v; load();
  });
  $('#av-dice').addEventListener('click', () => { st.seed = randomSeed(); seedInput.value = st.seed; load(); });
  $('#av-reset').addEventListener('click', () => load());
  startBtn.addEventListener('click', () => (st.running ? pause() : start()));
  $('#av-step').addEventListener('click', () => { if (st.running) pause(); if (st.phase === 0) beginIteration(); });
  $('#av-inject').addEventListener('click', () => {
    if (!eng) return;
    const f = eng.injectMalware();
    st.complete = false;
    log(`INJECTED simulated malware: ${f.name} into ${eng.dirs[f.dir].name} (ground truth: malicious, not yet investigated)`, 'mal');
    setPill(statusEl, 'error', 'Threat injected');
    renderAll();
  });
  $('#av-compare').addEventListener('click', () => {
    if (!eng) return;
    const out = $('#av-compare-out');
    out.textContent = 'Running both schedulers…';
    setTimeout(() => {
      const t0 = performance.now();
      const res = compareSchedulers(eng.dataset, { ...params }, st.seed);
      const ms = performance.now() - t0;
      const line = (name, r) => `${name.padEnd(16)} first confirmed threat: ${r.first ? `${r.first.evaluations} evals / ${r.first.cost.toFixed(1)} units (it ${r.first.iteration})` : 'none'}`
        + ` · all verdicts: ${r.complete ? `${r.evaluations} evals, coverage ${r.coverageCost.toFixed(1)} + monitoring ${r.monitorCost.toFixed(1)} units` : 'not reached'} · TP ${r.tp} FP ${r.fp} FN ${r.fn}`;
      out.innerHTML = `${escapeHtml(line('ACO (α,β as set)', res.aco))}<br>${escapeHtml(line('Uniform random', res.uniform))}`
        + `<br><span style="color:var(--muted)">Dataset: original ${eng.dataset.files.length}-file "${st.scenario}" scenario (seed ${st.seed}); injected files are not included. Computed in ${ms.toFixed(0)} ms.</span>`;
    }, 20);
  });

  // ------------------------------------------------------------- lifecycle
  function load() {
    pause();
    const ds = generateFileSystem(st.scenario, st.seed);
    eng = new AntivirusAco(ds, { ...params }, st.seed);
    st.selected = null;
    st.phase = 0;
    st.plan = null;
    st.snapshot = null;
    st.complete = false;
    st.newlyMalicious.clear();
    logEl.innerHTML = '';
    const nMal = ds.files.filter((f) => f.truth === 'malicious').length;
    log(`Loaded "${st.scenario}" scenario, seed ${st.seed}: ${ds.files.length} files in ${ds.dirs.length} folders (ground truth: ${nMal} malicious). Engine idle.`, 'info');
    $('#av-compare-out').textContent = '';
    setPill(statusEl, '', 'Idle');
    $('#av-phase').textContent = `${ds.files.length} files · press Scan or Step`;
    updateStartButton();
    renderAll();
  }

  function start() {
    if (st.complete) { setPill(statusEl, 'done', 'Scan complete'); return; }
    st.running = true;
    updateStartButton();
    setPill(statusEl, 'running', 'Scanning');
    if (st.phase === 0) beginIteration();
  }
  function pause() {
    st.running = false;
    updateStartButton();
    if (eng && !st.complete && st.phase === 0) setPill(statusEl, 'paused', 'Paused');
  }
  function updateStartButton() {
    const label = st.running ? 'Pause' : eng && eng.iteration > 0 && !st.complete ? 'Resume' : 'Scan';
    startBtn.innerHTML = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${st.running ? '<path d="M8 4v16M16 4v16"/>' : '<path d="M7 4v16l13-8z"/>'}</svg><span>${label}</span>`;
  }

  function beginIteration() {
    if (!eng) return;
    if (eng.isComplete()) { finish(); return; }
    st.snapshot = { tau: eng.files.map((f) => f.tau), status: eng.files.map((f) => f.status), riskHat: eng.files.map((f) => f.riskHat), n: eng.files.map((f) => f.n) };
    st.plan = eng.plan();
    st.commitResult = null;
    st.newlyMalicious.clear();
    if (!st.plan.picks.length) { finish(); return; }
    setPhase(1);
    if (!st.running) setPill(statusEl, 'running', 'Stepping');
    animator.start();
  }

  function setPhase(p) {
    st.phase = p;
    st.phaseStart = performance.now();
    $('#av-phase').innerHTML = `Iteration ${st.plan.iteration} · <b>${p}/7</b> ${PHASE_NAMES[p]}`;
    if (p === 3) {
      // the engine evaluates the selected files, computes evidence/risk, deposits, classifies
      st.commitResult = eng.commit(st.plan);
      logIteration(st.commitResult);
    }
    if (p === 7) {
      for (const e of st.commitResult.events) if (e.changed && e.status === STATUS.MALICIOUS) st.newlyMalicious.add(e.file);
      if (st.newlyMalicious.size) {
        const rank = trailRanking();
        const names = [...st.newlyMalicious].map((id) => `${eng.files[id].name} (trail #${rank.findIndex((f) => f.id === id) + 1})`);
        $('#av-phase').innerHTML = `Iteration ${st.plan.iteration} · <b style="color:#fda4af">Malware detected:</b> ${escapeHtml(names.join(', '))}`;
      }
    }
    renderPanels();
  }

  function endIteration() {
    st.phase = 0;
    st.snapshot = null;
    $('#av-phase').textContent = `Iteration ${eng.iteration} done`;
    st.complete = eng.isComplete();
    renderAll();
    if (st.complete) { finish(); return; }
    if (st.running) beginIteration();
    else { animator.stop(); setPill(statusEl, 'paused', 'Paused'); draw(); }
  }

  function finish() {
    st.running = false;
    st.complete = true;
    animator.stop();
    st.phase = 0;
    updateStartButton();
    const m = eng.metrics();
    setPill(statusEl, 'done', m.tp > 0 ? `Complete · ${m.tp} threat(s)` : 'Complete · no confirmed threats');
    const rank = trailRanking();
    const mal = eng.files.filter((f) => f.status === STATUS.MALICIOUS);
    const topIds = new Set(rank.slice(0, mal.length).map((f) => f.id));
    const matches = mal.length > 0 && mal.every((f) => topIds.has(f.id));
    $('#av-phase').innerHTML = mal.length === 0
      ? `Scan complete after ${eng.iteration} iterations · no file confirmed malicious`
      : matches
        ? `Scan complete · the <b>${mal.length} strongest trail${mal.length > 1 ? 's' : ''}</b> led to the ${mal.length} confirmed malware file${mal.length > 1 ? 's' : ''}`
        : `Scan complete · ${mal.length} malware file(s) confirmed (trail ranks ${mal.map((f) => `#${rank.findIndex((g) => g.id === f.id) + 1}`).join(', ')})`;
    log(`SCAN COMPLETE at iteration ${eng.iteration}: every file has a final verdict. TP ${m.tp}, FP ${m.fp}, FN ${m.fn}, flagged for review ${m.flagged}.`, 'info');
    renderAll();
  }

  const animator = new Runner(() => {
    const dur = PHASE_MS[st.phase] / SPEED_FACTOR[st.speed];
    if (st.phase > 0 && performance.now() - st.phaseStart >= dur) {
      if (st.phase < 7) setPhase(st.phase + 1);
      else { endIteration(); if (!st.running) return false; }
    }
    draw();
    return true;
  });

  // ------------------------------------------------------------- logging
  function log(msg, cls = '') {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = msg;
    logEl.append(d);
    while (logEl.childElementCount > 400) logEl.firstChild.remove();
    logEl.scrollTop = logEl.scrollHeight;
  }
  function logIteration(res) {
    const names = res.events.map((e) => eng.files[e.file].name);
    log(`[it ${res.iteration}] ${res.events.length} ant(s) selected: ${names.join(', ')}`, 'it');
    for (const e of res.events) {
      const f = eng.files[e.file];
      if (e.changed && (e.status === STATUS.MALICIOUS || e.status === STATUS.SUSPICIOUS || (e.status === STATUS.CLEAN && f.resolved))) {
        const cls = e.status === STATUS.MALICIOUS ? 'mal' : e.status === STATUS.SUSPICIOUS ? 'sus' : 'ok';
        const tag = e.status === STATUS.MALICIOUS ? 'CONFIRMED MALICIOUS' : e.status.toUpperCase();
        log(`[it ${res.iteration}]   ${f.name}: R̂ = ${f.riskHat.toFixed(3)} ± ${f.margin.toFixed(3)} (n=${f.n}) → ${tag}; Δτ = +${e.dTau.toFixed(3)}`, cls);
      }
    }
  }

  // ------------------------------------------------------------- layout & drawing
  let layout = null;
  function computeLayout(w, h) {
    const compact = w < 560;
    const cx = w / 2; const cy = h / 2 + (compact ? 8 : 14);
    const rx2 = Math.max(80, w / 2 - (compact ? 22 : 100));
    const ry2 = Math.max(80, h / 2 - (compact ? 34 : 56));
    const rx1 = rx2 * 0.42; const ry1 = ry2 * 0.42;
    const files = eng.files;
    const byDir = eng.dirs.map((d) => files.filter((f) => f.dir === d.id));
    const total = files.length;
    const gap = 0.12;
    const usable = Math.PI * 2 - gap * eng.dirs.length;
    let a = -Math.PI / 2 + gap / 2;
    const filePos = new Array(files.length);
    const dirPos = [];
    byDir.forEach((fs, di) => {
      const span = usable * (fs.length / total);
      const mid = a + span / 2;
      dirPos[di] = { x: cx + rx1 * Math.cos(mid), y: cy + ry1 * Math.sin(mid), a: mid };
      fs.forEach((f, k) => {
        const ang = a + span * ((k + 0.5) / fs.length);
        filePos[f.id] = { x: cx + rx2 * Math.cos(ang), y: cy + ry2 * Math.sin(ang), a: ang };
      });
      a += span + gap;
    });
    layout = { cx, cy, filePos, dirPos, compact, w, h };
  }

  function phaseProgress() {
    return Math.min(1, (performance.now() - st.phaseStart) / (PHASE_MS[st.phase] / SPEED_FACTOR[st.speed]));
  }
  function dispTau(f) {
    if (!st.snapshot || st.phase === 0) return f.tau;
    const before = st.snapshot.tau[f.id] ?? f.tau;
    if (st.phase < 4) return before;
    if (st.phase === 4) return before + (f.tau - before) * phaseProgress(); // trails visibly grow as ants return
    return f.tau;
  }
  /** Files ranked by (displayed) trail strength — the colony's current priority order. */
  function trailRanking() {
    return eng.files.filter((f) => dispN(f) > 0).sort((a, b) => dispTau(b) - dispTau(a));
  }
  function dispStatus(f) { return st.snapshot && st.phase > 0 && st.phase < 6 ? st.snapshot.status[f.id] ?? f.status : f.status; }
  function dispN(f) { return st.snapshot && st.phase > 0 && st.phase < 4 ? st.snapshot.n[f.id] ?? f.n : f.n; }

  function draw() {
    if (!eng) return;
    const { ctx, w, h } = fitCanvas(canvas);
    computeLayout(w, h);
    const { cx, cy, filePos, dirPos } = layout;
    ctx.clearRect(0, 0, w, h);
    const now = performance.now();
    const pr = eng.params;

    // root → directory edges: aggregate of child trails (display only)
    eng.dirs.forEach((d, di) => {
      const kids = eng.files.filter((f) => f.dir === di);
      const lvl = Math.max(0, ...kids.map((f) => (f.n > 0 ? trailLevel(dispTau(f), pr) : 0)));
      strokeTrail(ctx, cx, cy, dirPos[di].x, dirPos[di].y, lvl, lvl === 0);
    });
    // directory → file edges: the file's accumulated pheromone τ
    for (const f of eng.files) {
      const p = filePos[f.id]; const d = dirPos[f.dir];
      const neverInvestigated = dispN(f) === 0;
      strokeTrail(ctx, d.x, d.y, p.x, p.y, neverInvestigated ? 0 : trailLevel(dispTau(f), pr), neverInvestigated);
    }
    // root
    ctx.beginPath(); ctx.arc(cx, cy, 15, 0, Math.PI * 2); ctx.fillStyle = '#ffd23f'; ctx.fill();
    ctx.fillStyle = '#111'; ctx.font = '700 10px Inter, system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('NEST', cx, cy + 0.5);
    // directories
    eng.dirs.forEach((d, di) => {
      const p = dirPos[di];
      ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#1e1e26'; ctx.fill(); ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 1.5; ctx.stroke();
      const label = d.name.replace('C:/', '');
      ctx.font = '600 10.5px Fira Code, monospace';
      const lw = ctx.measureText(label).width + 10;
      const ly = p.y + (Math.sin(p.a) >= 0 ? 20 : -18);
      ctx.fillStyle = 'rgba(9,9,11,0.85)';
      ctx.fillRect(p.x - lw / 2, ly - 8, lw, 16);
      ctx.fillStyle = '#b9b9c6';
      ctx.fillText(label, p.x, ly + 0.5);
    });
    // files
    for (const f of eng.files) {
      const p = filePos[f.id];
      const status = dispStatus(f);
      const r = layout.compact ? 6 : 8;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = COLORS[status]; ctx.fill();
      if (status === STATUS.MALICIOUS) {
        const pulse = st.newlyMalicious.has(f.id) ? 0.5 + 0.5 * Math.sin(now / 120) : 0.6;
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 9, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(244,63,94,${pulse})`; ctx.lineWidth = 2; ctx.stroke();
      }
      if (st.selected === f.id) {
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 7, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    // rank badges on the three strongest trails
    const ranking = trailRanking();
    const rankOf = new Map(ranking.map((f, i) => [f.id, i + 1]));
    if (eng.iteration > 0 || st.phase >= 4) {
      ranking.slice(0, 3).forEach((f, i) => {
        const p = filePos[f.id];
        const bx = p.x + (p.x >= cx ? -1 : 1) * 0; const by = p.y + 16;
        ctx.beginPath(); ctx.arc(bx, by, 8, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? '#ffd23f' : 'rgba(255,210,63,0.75)'; ctx.fill();
        ctx.fillStyle = '#111'; ctx.font = '700 9px Inter, system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(`#${i + 1}`, bx, by + 0.5);
      });
    }
    // phase-specific overlays: ants walking out, inspecting, and walking back laying pheromone
    if (st.phase >= 1 && st.phase <= 4) drawAnts(ctx, now);
    if (st.phase >= 2 && st.phase <= 3 && st.plan) {
      for (const pk of st.plan.picks) {
        const p = filePos[pk.file];
        const k = (now / 300) % 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, 10 + 10 * k, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(96,165,250,${1 - k})`; ctx.lineWidth = 2; ctx.stroke();
      }
    }
    if (st.phase === 4 && st.commitResult) {
      // each ant's own deposit Δτ, shown at the file it investigated
      const t = phaseProgress();
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.font = '700 11px Fira Code, monospace';
      for (const e of st.commitResult.events) {
        const p = filePos[e.file];
        ctx.fillStyle = `rgba(255,210,63,${1 - t * 0.5})`;
        ctx.fillText(`+${e.dTau.toFixed(2)} τ`, p.x, p.y - 16 - 12 * t);
      }
    }
    // labels: flagged files, the strongest trail, the selected file and the hovered file
    for (const f of eng.files) {
      const status = dispStatus(f);
      const flagged = status === STATUS.MALICIOUS || status === STATUS.SUSPICIOUS;
      if (flagged || rankOf.get(f.id) === 1 || st.selected === f.id || st.hover === f.id) drawLabel(ctx, f, status, w, rankOf.get(f.id));
    }
    // detection moment: a file whose strong trail has just been confirmed by the evidence
    if (st.phase === 7 && st.newlyMalicious.size) {
      const t = phaseProgress();
      for (const id of st.newlyMalicious) {
        const p = filePos[id];
        for (let k = 0; k < 3; k++) {
          const q = (t + k / 3) % 1;
          ctx.beginPath(); ctx.arc(p.x, p.y, 10 + 40 * q, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(244,63,94,${0.9 * (1 - q)})`; ctx.lineWidth = 3; ctx.stroke();
        }
        drawCallout(ctx, p, `MALWARE DETECTED · strongest trail #${rankOf.get(id) ?? '?'}`, w, h);
      }
    }
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
  }

  function drawCallout(ctx, p, text, w, h) {
    ctx.font = '800 12px Inter, system-ui';
    const tw = ctx.measureText(text).width + 20;
    let x = p.x - tw / 2; let y = p.y < layout.cy ? p.y + 26 : p.y - 50;
    x = Math.max(6, Math.min(w - tw - 6, x)); y = Math.max(6, Math.min(h - 30, y));
    ctx.fillStyle = '#f43f5e';
    ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, tw, 24, 7); else ctx.rect(x, y, tw, 24); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 10, y + 12.5);
  }

  function drawLabel(ctx, f, status, w, rank) {
    const p = layout.filePos[f.id];
    const right = p.x >= layout.cx;
    ctx.font = '600 11px Inter, system-ui';
    const text = status === STATUS.MALICIOUS ? `${f.name} · MALWARE${rank ? ` · trail #${rank}` : ''}` : rank === 1 ? `${f.name} · strongest trail` : f.name;
    const tw = ctx.measureText(text).width + 12;
    let x = right ? p.x + 14 : p.x - 14 - tw;
    x = Math.max(4, Math.min(w - tw - 4, x));
    const y = p.y - 10;
    ctx.fillStyle = 'rgba(12,12,16,0.88)';
    ctx.strokeStyle = status === STATUS.MALICIOUS ? 'rgba(244,63,94,0.7)' : status === STATUS.SUSPICIOUS ? 'rgba(245,158,11,0.6)' : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, tw, 20, 6); else ctx.rect(x, y, tw, 20);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = status === STATUS.MALICIOUS ? '#fecdd3' : status === STATUS.SUSPICIOUS ? '#fde68a' : '#ededf2';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 6, y + 10.5);
  }

  function strokeTrail(ctx, x1, y1, x2, y2, lvl, neutral) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    if (neutral) {
      ctx.strokeStyle = 'rgba(120,120,135,0.16)'; ctx.lineWidth = 1; ctx.stroke();
      return;
    }
    ctx.lineWidth = 0.8 + 6 * lvl;
    ctx.strokeStyle = `rgba(255,210,63,${0.12 + 0.85 * lvl})`;
    if (lvl > 0.7) { ctx.shadowColor = '#ffd23f'; ctx.shadowBlur = 12 * lvl; }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function drawAnts(ctx, now) {
    if (!st.plan) return;
    const { cx, cy, filePos, dirPos } = layout;
    const t = phaseProgress();
    const along = (pk, u) => { // u: 0 = nest, 0.5 = folder, 1 = file
      const d = dirPos[pk.dir]; const f = filePos[pk.file];
      if (u < 0.5) { const q = u / 0.5; return [cx + (d.x - cx) * q, cy + (d.y - cy) * q]; }
      const q = (u - 0.5) / 0.5; return [d.x + (f.x - d.x) * q, d.y + (f.y - d.y) * q];
    };
    st.plan.picks.forEach((pk, k) => {
      const lag = (k % 6) * 0.035;
      let u;
      if (st.phase === 1) u = Math.max(0, Math.min(1, t * 1.2 - lag)); // outbound
      else if (st.phase === 4) u = 1 - Math.max(0, Math.min(1, t * 1.2 - lag)); // homeward, laying pheromone
      else u = 1; // at the file, inspecting
      if (st.phase === 4) {
        // pheromone droplets left behind the returning ant
        for (let j = 1; j <= 6; j++) {
          const uu = Math.min(1, u + j * 0.035);
          const [x, y] = along(pk, uu);
          ctx.beginPath(); ctx.arc(x, y, 2.6 - j * 0.3, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,210,63,${0.8 - j * 0.11})`; ctx.fill();
        }
      }
      const [x, y] = along(pk, u);
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = st.phase === 4 ? '#ffe680' : '#ffffff';
      ctx.shadowColor = '#ffd23f'; ctx.shadowBlur = st.phase === 4 ? 10 : 4;
      ctx.fill(); ctx.shadowBlur = 0;
    });
  }

  // ------------------------------------------------------------- panels
  function renderRanking() {
    const box = $('#av-ranking');
    if (!box) return;
    const rank = trailRanking();
    if (!rank.length) { box.innerHTML = '<p class="hint">No trails yet. Press <b>Scan</b>: ants leave the nest, inspect files and lay pheromone on the way back.</p>'; return; }
    const top = rank.slice(0, 6);
    const max = Math.max(...top.map((f) => dispTau(f)), 1e-9);
    const tag = { malicious: 'MALWARE', suspicious: 'suspicious', clean: 'clean', scanning: 'checking', pending: 'pending' };
    box.innerHTML = top.map((f, i) => {
      const status = dispStatus(f);
      return `<button class="rank-row st-row-${status}" data-id="${f.id}"><span class="rk">#${i + 1}</span><span class="nm">${escapeHtml(f.name)}</span>
        <span class="tr"><span style="width:${((dispTau(f) / max) * 100).toFixed(0)}%"></span></span><span class="tg st-${status}">${tag[status]}</span></button>`;
    }).join('');
    box.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => { st.selected = Number(b.dataset.id); renderAll(); }));
  }

  function renderStats() {
    renderRanking();
    const m = eng.metrics();
    $('#av-it').textContent = eng.iteration;
    $('#av-scanned').textContent = `${m.scanned} / ${m.total}`;
    $('#av-threats').textContent = m.tp + m.fp;
    $('#av-threats').classList.toggle('red', m.tp + m.fp > 0);
    $('#av-flagged').textContent = m.flagged;
    $('#av-evals').innerHTML = `${m.evaluations}${m.monitorEvaluations ? ` <small>(${m.monitorEvaluations} monitor)</small>` : ''}`;
    $('#av-cost').textContent = m.costUnits.toFixed(1);
    $('#av-tp').textContent = m.tp; $('#av-fp').textContent = m.fp; $('#av-fn').textContent = m.fn; $('#av-tn').textContent = m.tn;
    $('#av-prec').textContent = m.precision == null ? 'undefined' : fmt.pct(m.precision);
    $('#av-rec').textContent = m.recall == null ? 'undefined' : fmt.pct(m.recall);
    $('#av-f1').textContent = m.f1 == null ? 'undefined' : m.f1.toFixed(3);
  }

  function renderInspector() {
    const box = $('#av-inspector');
    const has = st.selected != null && !!eng.files[st.selected];
    box.hidden = !has;
    $('#av-summary').hidden = has;
    $('#av-side-back').hidden = !has;
    $('#av-side-title').innerHTML = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${has ? '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/>' : '<path d="M12 3v18M5 7h14M5 7l-3 7h6zM19 7l-3 7h6z"/>'}</svg>${has ? 'File inspector' : 'Scan summary'}`;
    if (!has) return;
    const f = eng.files[st.selected];
    const w = normaliseWeights(eng.params.weights);
    const probs = eng.fileSelectionProbabilities();
    const est = f.est || { sig: 0, beh: 0, attr: 0 };
    const C = eng.confidence(f.n);
    const bar = (label, v, weight) => `<div class="bar"><span>${label}</span><div class="track"><div class="fill" style="width:${(v * 100).toFixed(0)}%"></div></div><span class="num">${f.n ? v.toFixed(2) : '—'}</span></div>`;
    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">
        <div><div class="mono" style="font-size:14px;color:var(--text)">${escapeHtml(f.name)}</div><div class="hint">${escapeHtml(eng.dirs[f.dir].name)} · .${f.ext} · ${(f.sizeKB / 1024).toFixed(1)} MB</div></div>
        <span class="status-tag st-${f.status}">${STATUS_LABEL[f.status]}${f.resolved ? ' · final' : ''}</span>
      </div>
      <div class="bars" style="margin-top:12px">
        ${bar('Signature', est.sig, w.sig)}${bar('Behaviour', est.beh, w.beh)}${bar('Attributes', est.attr, w.attr)}
      </div>
      <div class="formula" style="margin-top:10px">R̂ = ${w.sig.toFixed(2)}·${f.n ? est.sig.toFixed(2) : 's'} + ${w.beh.toFixed(2)}·${f.n ? est.beh.toFixed(2) : 'b'} + ${w.attr.toFixed(2)}·${f.n ? est.attr.toFixed(2) : 'a'} = <b>${f.riskHat != null ? f.riskHat.toFixed(3) : '—'}</b>${f.margin != null ? ` ± ${f.margin.toFixed(3)}` : ''}</div>
      <dl class="kv" style="margin-top:10px">
        <dt>Investigations n</dt><dd>${f.n}${f.status === STATUS.MALICIOUS && f.n > eng.params.maxInvestigations ? ' (incl. monitoring re-scans after confirmation)' : ` / budget ${eng.params.maxInvestigations}`}</dd>
        <dt>Evidence confidence C(n)</dt><dd>${C.toFixed(3)}</dd>
        <dt>Pheromone τ (accumulated)</dt><dd>${f.tau.toFixed(3)} · trail ${(trailLevel(f.tau, eng.params) * 100).toFixed(0)}%${f.n === 0 ? ' (neutral τ₀)' : ''}</dd>
        <dt>Last iteration deposit</dt><dd>${f.antsLast ? `+${f.depositsLast.toFixed(3)} from ${f.antsLast} ant` : '—'}</dd>
        <dt>Visibility η = π(1−C)</dt><dd>${eng.eta(f).toFixed(3)} (prior π ${f.prior.toFixed(2)})</dd>
        <dt>P(selected by an ant next)</dt><dd>${(probs[f.id] * 100).toFixed(2)}%</dd>
        <dt>Ground truth (hidden from detector)</dt><dd style="color:${f.truth === 'malicious' ? '#fda4af' : 'var(--text-2)'}">${f.truth}${f.kind === 'zeroday' ? ' (zero-day-like)' : f.kind === 'grey' ? ' (grey / unusual)' : ''}</dd>
      </dl>
      <div class="hint" style="margin-top:10px">τ history (${f.tauHistory.length} iterations)</div>
      <canvas class="spark" id="av-spark"></canvas>
      <div class="hint" style="margin:8px 0 4px">Why this classification</div>
      <ul class="reasons">${f.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`;
    drawSparkline($('#av-spark'), f.tauHistory.map((x) => x.tau));
  }

  function renderPanels() { if (!eng) return; renderStats(); renderInspector(); }
  function renderAll() { draw(); renderPanels(); updateStartButton(); }

  canvas.addEventListener('click', (ev) => {
    if (!eng || !layout) return;
    const r = canvas.getBoundingClientRect();
    const x = ev.clientX - r.left; const y = ev.clientY - r.top;
    let best = null; let bd = 16;
    for (const f of eng.files) { const p = layout.filePos[f.id]; const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = f.id; } }
    st.selected = best;
    renderAll();
  });
  canvas.addEventListener('mousemove', (ev) => {
    if (!eng || !layout) return;
    const r = canvas.getBoundingClientRect();
    const x = ev.clientX - r.left; const y = ev.clientY - r.top;
    let best = null; let bd = 14;
    for (const f of eng.files) { const p = layout.filePos[f.id]; const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = f.id; } }
    if (best !== st.hover) { st.hover = best; canvas.style.cursor = best == null ? 'default' : 'pointer'; if (!animator.running) draw(); }
  });
  canvas.addEventListener('mouseleave', () => { st.hover = null; if (!animator.running) draw(); });
  new ResizeObserver(() => draw()).observe(canvas);
  document.addEventListener('visibilitychange', () => { if (document.hidden && st.running) pause(); });

  load();

  return {
    get engine() { return eng; },
    get state() { return st; },
    pause,
    start,
    configure({ scenario, seed, ants, rho }) {
      pause();
      if (scenario) { st.scenario = scenario; scenarioSeg.set(scenario, false); }
      if (seed) { st.seed = seed; seedInput.value = seed; }
      if (ants) setAnts(ants, true);
      if (rho) setRho(rho, true);
      load();
    },
    /** Run k iterations instantly (no animation) — same engine calls as the animated path. */
    fastForward(k) {
      pause();
      animator.stop();
      st.phase = 0; st.snapshot = null;
      for (let i = 0; i < k && !eng.isComplete(); i++) logIteration(eng.step());
      st.complete = eng.isComplete();
      if (st.complete) finish(); else setPill(statusEl, 'paused', 'Paused');
      renderAll();
    },
    stepAnimated() { if (st.phase === 0) beginIteration(); },
    select(id) { st.selected = id; renderAll(); },
  };
}
