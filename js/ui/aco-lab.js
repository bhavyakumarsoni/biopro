// Lab 1 — UI controller for the TSP Ant System. All drawing reads the engine's state.

import { createRng, randomSeed } from '../core/rng.js';
import { TspAntSystem, makePreset, heldKarp, circleOptimum, WORLD, distance, tourHasEdge } from '../core/tsp-aco.js';
import { $, fmt, bindRange, bindSeg, setPill, fitCanvas, drawSparkline, Runner, escapeHtml } from './util.js';
import { lineChart, setSeries } from './charts.js';

const MAX_NODES = 40;
const HK_LIMIT = 15;

export function initAcoLab() {
  const canvas = $('#aco-canvas');
  const statusEl = $('#aco-status');
  const startBtn = $('#aco-start');

  const state = {
    preset: 'random',
    n: 12,
    seed: 2026,
    mode: 'inspect',
    speed: 12,
    maxIt: 300,
    selected: null, // {i, j}
    nodes: [],
    optimum: null, // {length, label}
    phase: 'idle',
    lastStepAt: 0,
    animStart: 0,
  };
  const params = { alpha: 1, beta: 3, rho: 0.1, ants: 30 };
  let aco = null;

  // ------------------------------------------------------------- controls
  const setAlpha = bindRange($('#aco-alpha'), $('#aco-alpha-v'), (v) => { params.alpha = v; aco?.setParams({ alpha: v }); refreshInspector(); }, (v) => v.toFixed(1));
  const setBeta = bindRange($('#aco-beta'), $('#aco-beta-v'), (v) => { params.beta = v; aco?.setParams({ beta: v }); refreshInspector(); }, (v) => v.toFixed(1));
  const setRho = bindRange($('#aco-rho'), $('#aco-rho-v'), (v) => { params.rho = v; aco?.setParams({ rho: v }); }, (v) => v.toFixed(2));
  const setAnts = bindRange($('#aco-ants'), $('#aco-ants-v'), (v) => { params.ants = v; aco?.setParams({ ants: v }); }, (v) => String(v));
  bindRange($('#aco-speed'), $('#aco-speed-v'), (v) => { state.speed = v; }, (v) => `${v}/s`);
  bindRange($('#aco-maxit'), $('#aco-maxit-v'), (v) => { state.maxIt = v; if (aco && aco.iteration < v && state.phase === 'done') setPhase('paused'); }, (v) => String(v));
  const setN = bindRange($('#aco-n'), $('#aco-n-v'), (v) => { state.n = v; buildGraph(); }, (v) => String(v));
  const presetSeg = bindSeg($('#aco-preset'), (v) => { state.preset = v; buildGraph(); });
  const modeSeg = bindSeg($('#aco-mode'), (v) => { state.mode = v; canvas.style.cursor = v === 'inspect' ? 'pointer' : 'crosshair'; });
  const seedInput = $('#aco-seed');
  seedInput.addEventListener('change', () => {
    const v = Math.floor(Number(seedInput.value));
    if (!(v >= 1 && v <= 999999999)) { seedInput.value = state.seed; return; }
    state.seed = v;
    buildGraph();
  });
  $('#aco-dice').addEventListener('click', () => { state.seed = randomSeed(); seedInput.value = state.seed; buildGraph(); });
  startBtn.addEventListener('click', () => (runner.running ? pause() : start()));
  $('#aco-step').addEventListener('click', () => { pause(); doStep(); });
  $('#aco-reset').addEventListener('click', () => reset());

  const chart = lineChart($('#aco-chart'), [
    { label: 'best-so-far', color: '#ffd23f', width: 2.4 },
    { label: 'iteration best', color: '#2dd4bf', width: 1.4 },
    { label: 'average ant', color: '#8b8b9a', width: 1.2, dash: [4, 3] },
  ], { yTitle: 'tour length', refLine: { label: 'exact optimum', color: '#f43f5e' } });

  // ------------------------------------------------------------- model
  function buildGraph() {
    pause();
    state.nodes = makePreset(state.preset, createRng(state.seed), state.n);
    rebuildEngine();
  }

  function rebuildEngine() {
    aco = new TspAntSystem(state.nodes, params, state.seed);
    state.selected = null;
    computeOptimum();
    setPhase('idle');
    renderAll();
  }

  function computeOptimum() {
    const n = state.nodes.length;
    state.optimum = null;
    if (n < 3) return;
    if (state.preset === 'circle' && state.nodes.$pristine !== false && n === state.n) {
      state.optimum = { length: circleOptimum(state.nodes), label: 'Exact optimum (polygon)' };
    } else if (n <= HK_LIMIT) {
      const hk = heldKarp(aco.dist, HK_LIMIT);
      state.optimum = hk ? { length: hk.length, label: 'Exact optimum (Held–Karp)' } : null;
    }
  }

  function reset() {
    pause();
    aco.reset(state.seed);
    state.selected = null;
    setPhase('idle');
    renderAll();
  }

  function doStep() {
    if (!aco || aco.n < 3) { setPhase('error', 'Need ≥ 3 nodes'); return false; }
    if (aco.iteration >= state.maxIt) { setPhase('done'); return false; }
    aco.step();
    state.animStart = performance.now();
    if (aco.iteration >= state.maxIt) setPhase('done');
    else if (!runner.running) setPhase('paused');
    renderAll();
    return true;
  }

  // ------------------------------------------------------------- run loop
  const runner = new Runner((t) => {
    if (t - state.lastStepAt >= 1000 / state.speed) {
      state.lastStepAt = t;
      if (!doStep()) { pause(); return false; }
    }
    draw();
    return true;
  });

  function start() {
    if (!aco || aco.n < 3) { setPhase('error', 'Need ≥ 3 nodes'); return; }
    if (aco.iteration >= state.maxIt) { setPhase('done'); return; }
    setPhase('running');
    runner.start();
  }
  function pause() {
    const was = runner.running;
    runner.stop();
    if (was && state.phase === 'running') setPhase('paused');
    draw();
  }

  function setPhase(p, msg) {
    state.phase = p;
    const labels = { idle: 'Idle', running: 'Running', paused: 'Paused', done: 'Completed', error: msg || 'Error' };
    setPill(statusEl, p === 'idle' ? '' : p, labels[p]);
    const icon = p === 'running' ? 'pause' : 'play';
    const text = p === 'running' ? 'Pause' : aco && aco.iteration > 0 && p !== 'done' ? 'Resume' : 'Start';
    startBtn.innerHTML = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${icon === 'pause' ? '<path d="M8 4v16M16 4v16"/>' : '<path d="M7 4v16l13-8z"/>'}</svg><span>${text}</span>`;
    startBtn.disabled = p === 'done';
  }

  // ------------------------------------------------------------- geometry
  let view = { s: 1, ox: 0, oy: 0, w: 0, h: 0 };
  function computeView(w, h) {
    const pad = 24;
    const s = Math.min((w - 2 * pad) / WORLD.w, (h - 2 * pad) / WORLD.h);
    view = { s, ox: (w - WORLD.w * s) / 2, oy: (h - WORLD.h * s) / 2, w, h };
  }
  const sx = (p) => view.ox + p.x * view.s;
  const sy = (p) => view.oy + p.y * view.s;
  const toWorld = (x, y) => ({ x: (x - view.ox) / view.s, y: (y - view.oy) / view.s });

  // ------------------------------------------------------------- drawing
  function draw() {
    const { ctx, w, h } = fitCanvas(canvas);
    computeView(w, h);
    ctx.clearRect(0, 0, w, h);
    // subtle grid
    ctx.strokeStyle = 'rgba(255,255,255,0.025)';
    ctx.lineWidth = 1;
    for (let gx = 0; gx <= WORLD.w; gx += 100) { ctx.beginPath(); ctx.moveTo(sx({ x: gx }), sy({ y: 0 })); ctx.lineTo(sx({ x: gx }), sy({ y: WORLD.h })); ctx.stroke(); }
    for (let gy = 0; gy <= WORLD.h; gy += 100) { ctx.beginPath(); ctx.moveTo(sx({ x: 0 }), sy({ y: gy })); ctx.lineTo(sx({ x: WORLD.w }), sy({ y: gy })); ctx.stroke(); }
    if (!aco) return;
    const n = aco.n;
    const nodes = aco.nodes;
    const tmax = aco.maxTau() || 1;
    // pheromone edges: weak first, strong last
    const edges = [];
    // before the first iteration every τ equals τ0: draw a neutral baseline, not "100 % strong"
    const fresh = aco.iteration === 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) edges.push([i, j, fresh ? 0.08 : aco.tau[i][j] / tmax]);
    edges.sort((a, b) => a[2] - b[2]);
    for (const [i, j, r] of edges) {
      const rel = Math.max(0, Math.min(1, r));
      ctx.beginPath();
      ctx.moveTo(sx(nodes[i]), sy(nodes[i]));
      ctx.lineTo(sx(nodes[j]), sy(nodes[j]));
      ctx.lineWidth = 0.4 + 5.6 * rel;
      ctx.strokeStyle = `rgba(255, 210, 63, ${0.05 + 0.9 * rel ** 1.2})`;
      if (rel > 0.6) { ctx.shadowColor = '#ffd23f'; ctx.shadowBlur = 10 * rel; } else ctx.shadowBlur = 0;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    // best-so-far tour
    if (aco.best) {
      ctx.beginPath();
      const t = aco.best.tour;
      t.forEach((v, k) => (k ? ctx.lineTo(sx(nodes[v]), sy(nodes[v])) : ctx.moveTo(sx(nodes[v]), sy(nodes[v]))));
      ctx.closePath();
      ctx.strokeStyle = '#2dd4bf';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([7, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // selected edge
    if (state.selected) {
      const { i, j } = state.selected;
      ctx.beginPath();
      ctx.moveTo(sx(nodes[i]), sy(nodes[i]));
      ctx.lineTo(sx(nodes[j]), sy(nodes[j]));
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    // ants: real tours of the last iteration, interpolated during the inter-iteration interval
    const last = aco.lastIteration;
    if (last) {
      const period = runner.running ? 1000 / state.speed : 900;
      const p = Math.min(1, (performance.now() - state.animStart) / period);
      const show = last.tours.slice(0, 40);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      for (const { tour } of show) {
        const pos = p * n;
        const k = Math.min(n - 1, Math.floor(pos));
        const f = pos - k;
        const a = nodes[tour[k]];
        const b = nodes[tour[(k + 1) % n]];
        ctx.beginPath();
        ctx.arc(sx(a) + (sx(b) - sx(a)) * f, sy(a) + (sy(b) - sy(a)) * f, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      if (p < 1 && !runner.running) requestAnimationFrame(draw);
    }
    // nodes
    nodes.forEach((p, idx) => {
      const x = sx(p); const y = sy(p);
      const sel = state.selected && (state.selected.i === idx || state.selected.j === idx);
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.fillStyle = sel ? '#ffffff' : '#ffd23f';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#09090b';
      ctx.stroke();
      ctx.fillStyle = '#111';
      ctx.font = '600 10px Fira Code, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(idx + 1), x, y + 0.5);
    });
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
    if (n < 3) {
      ctx.fillStyle = '#868697';
      ctx.font = '13px Inter, system-ui';
      ctx.fillText('Add at least 3 nodes (Add node mode) to run the colony.', 20, 28);
    }
  }

  function renderStats() {
    const it = aco?.iteration || 0;
    $('#aco-it').textContent = it;
    const best = aco?.best?.length;
    $('#aco-best').textContent = fmt.n(best, 1);
    const h = aco?.history;
    $('#aco-ibest').textContent = h && h.iterBest.length ? fmt.n(h.iterBest.at(-1), 1) : '—';
    $('#aco-avg').textContent = h && h.avg.length ? fmt.n(h.avg.at(-1), 1) : '—';
    const n = aco?.n || 0;
    if (state.optimum) {
      $('#aco-opt-k').textContent = state.optimum.label;
      $('#aco-opt').textContent = fmt.n(state.optimum.length, 1);
      const g = best != null ? ((best - state.optimum.length) / state.optimum.length) * 100 : null;
      $('#aco-gap').textContent = g == null ? '—' : `${Math.abs(g) < 1e-7 ? '0.00' : g.toFixed(2)}%${Math.abs(g) < 1e-7 ? ' (optimal)' : ''}`;
    } else {
      $('#aco-opt-k').textContent = 'Exact optimum';
      $('#aco-opt').innerHTML = `<small>n = ${n} &gt; ${HK_LIMIT}: not computed</small>`;
      $('#aco-gap').textContent = '—';
    }
    $('#aco-taumax').textContent = aco ? `τmax = ${fmt.sci(aco.maxTau())} · τ0 = ${fmt.sci(aco.tau0)}` : '';
    if (chart && h) setSeries(chart, [h.best, h.iterBest, h.avg], state.optimum?.length ?? null);
  }

  function refreshInspector() {
    const box = $('#aco-inspector');
    if (!aco || !state.selected) return;
    const { i, j } = state.selected;
    const e = aco.edgeInfo(i, j);
    if (!e) { box.innerHTML = '<p class="inspector-empty">Edge no longer exists.</p>'; return; }
    const tmax = aco.maxTau() || 1;
    const rel = e.tau / tmax;
    const band = aco.iteration === 0 ? 'uniform τ0 — no iteration yet' : rel > 0.6 ? 'strong' : rel >= 0.25 ? 'medium' : 'weak';
    const visited = new Uint8Array(aco.n);
    visited[e.i] = 1;
    const probs = aco.transitionProbabilities(e.i, visited).sort((a, b) => b.p - a.p);
    const top = probs.slice(0, 7);
    if (!top.some((c) => c.j === e.j)) { const me = probs.find((c) => c.j === e.j); if (me) top.push(me); }
    $('#aco-insp-sub').textContent = `edge ${e.i + 1} – ${e.j + 1}`;
    box.innerHTML = `
      <dl class="kv">
        <dt>Pheromone τ</dt><dd>${fmt.sci(e.tau)} <span style="color:var(--muted)">(${aco.iteration === 0 ? band : `${(rel * 100).toFixed(0)}% of max · ${band}`})</span></dd>
        <dt>Distance d</dt><dd>${fmt.n(e.distance, 1)} units</dd>
        <dt>Heuristic η = 1/d</dt><dd>${fmt.sci(e.eta)}</dd>
        <dt>Last deposit Σ Q/L<sub>k</sub></dt><dd>${fmt.sci(e.lastDeposit)} (${e.lastAnts} ants)</dd>
        <dt>In best-so-far tour</dt><dd>${e.inBest ? 'yes' : 'no'}</dd>
      </dl>
      <div style="margin-top:12px" class="hint">τ history (${e.history.length} iterations)</div>
      <canvas class="spark" id="aco-spark"></canvas>
      <div style="margin-top:10px" class="hint">P(next = j | ant at node ${e.i + 1}, nothing else visited) — live from τ<sup>α</sup>η<sup>β</sup> with α=${params.alpha}, β=${params.beta}</div>
      <div class="bars" style="margin-top:6px">${top.map((c) => `
        <div class="bar"><span class="mono" style="color:${c.j === e.j ? 'var(--gold)' : 'var(--text-2)'}">${e.i + 1} → ${c.j + 1}</span>
        <div class="track"><div class="fill" style="width:${(c.p * 100).toFixed(1)}%;${c.j === e.j ? '' : 'background:#6b6b7a'}"></div></div>
        <span class="num">${(c.p * 100).toFixed(1)}%</span></div>`).join('')}
      </div>`;
    drawSparkline($('#aco-spark'), e.history.map((x) => x.tau));
  }

  function renderAll() {
    draw();
    renderStats();
    if (state.selected) refreshInspector();
    else {
      $('#aco-insp-sub').textContent = 'click an edge (Inspect mode)';
      $('#aco-inspector').innerHTML = '<p class="inspector-empty">Select an edge on the canvas to see its pheromone τ, distance, heuristic η, last deposit and full τ history, plus the live transition probabilities from its first node.</p>';
    }
  }

  // ------------------------------------------------------------- interaction
  function nearestNode(px, py, maxPx) {
    let best = -1; let bd = maxPx;
    aco.nodes.forEach((p, k) => { const d = Math.hypot(sx(p) - px, sy(p) - py); if (d < bd) { bd = d; best = k; } });
    return best;
  }
  function nearestEdge(px, py, maxPx) {
    let best = null; let bd = maxPx;
    const nodes = aco.nodes;
    for (let i = 0; i < aco.n; i++) {
      for (let j = i + 1; j < aco.n; j++) {
        const ax = sx(nodes[i]); const ay = sy(nodes[i]); const bx = sx(nodes[j]); const by = sy(nodes[j]);
        const dx = bx - ax; const dy = by - ay; const L2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
        const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        // prefer edges with more pheromone when several are within reach
        const score = d - 3 * (aco.tau[i][j] / (aco.maxTau() || 1));
        if (score < bd) { bd = score; best = { i, j }; }
      }
    }
    return best;
  }
  canvas.addEventListener('click', (ev) => {
    if (!aco) return;
    const r = canvas.getBoundingClientRect();
    const px = ev.clientX - r.left; const py = ev.clientY - r.top;
    if (state.mode === 'inspect') {
      const hitNode = nearestNode(px, py, 10);
      if (hitNode >= 0 && aco.n > 1) {
        // clicking a node selects its strongest edge
        let bj = -1; let bt = -1;
        for (let j = 0; j < aco.n; j++) if (j !== hitNode && aco.tau[hitNode][j] > bt) { bt = aco.tau[hitNode][j]; bj = j; }
        state.selected = { i: Math.min(hitNode, bj), j: Math.max(hitNode, bj) };
      } else {
        state.selected = nearestEdge(px, py, 12);
      }
      renderAll();
    } else if (state.mode === 'add') {
      const w = toWorld(px, py);
      if (w.x < 0 || w.y < 0 || w.x > WORLD.w || w.y > WORLD.h) return;
      if (state.nodes.length >= MAX_NODES) { setPhase('error', `Max ${MAX_NODES} nodes`); return; }
      if (state.nodes.some((q) => distance(q, w) < 20)) { setPhase('error', 'Too close to a node'); return; }
      pause();
      state.nodes = [...state.nodes, w];
      state.nodes.$pristine = false;
      setN(state.nodes.length);
      rebuildEngine();
    } else if (state.mode === 'remove') {
      const k = nearestNode(px, py, 14);
      if (k < 0) return;
      pause();
      state.nodes = state.nodes.filter((_, q) => q !== k);
      state.nodes.$pristine = false;
      setN(Math.max(5, state.nodes.length));
      rebuildEngine();
    }
  });

  new ResizeObserver(() => draw()).observe(canvas);
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

  buildGraph();

  // API for the guided demo (drives the real engine, no separate animation)
  return {
    get engine() { return aco; },
    get state() { return state; },
    pause,
    start,
    reset,
    step(k = 1) { pause(); for (let q = 0; q < k; q++) if (!doStep()) break; },
    select(i, j) { state.selected = { i: Math.min(i, j), j: Math.max(i, j) }; renderAll(); },
    configure({ preset, n, seed, alpha, beta, rho, ants, maxIt }) {
      pause();
      if (alpha != null) setAlpha(alpha, true);
      if (beta != null) setBeta(beta, true);
      if (rho != null) setRho(rho, true);
      if (ants != null) setAnts(ants, true);
      if (maxIt != null) { state.maxIt = maxIt; $('#aco-maxit').value = maxIt; $('#aco-maxit-v').textContent = maxIt; }
      if (seed != null) { state.seed = seed; seedInput.value = seed; }
      if (n != null) { state.n = n; setN(n); }
      if (preset) { state.preset = preset; presetSeg.set(preset, false); }
      buildGraph();
      modeSeg.set('inspect', false);
      state.mode = 'inspect';
    },
    describeEdge() {
      const s = state.selected;
      return s && aco ? aco.edgeInfo(s.i, s.j) : null;
    },
    escape: escapeHtml,
    tourHasEdge,
  };
}
