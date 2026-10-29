// App shell: tab navigation (with URL hash), lab initialisation and the guided demo.
// The guided demo drives the REAL engines through each lab's API — no separate animation.

import { $, $$, hydrateIcons, typeset } from './util.js';
import { initAcoLab } from './aco-lab.js';
import { initAvLab } from './av-lab.js';
import { initMapLab } from './map-lab.js';
import { initDeck } from './deck.js';
import { STATUS } from '../core/antivirus.js';

function boot() {
  hydrateIcons();
  const labs = {};
  const safeInit = (name, fn) => {
    try { labs[name] = fn(); } catch (err) {
      console.error(`[${name}] failed to initialise`, err);
      const view = $(`#view-${name}`);
      const b = document.createElement('div');
      b.className = 'banner err';
      b.textContent = `This lab failed to start: ${err.message}`;
      view.prepend(b);
    }
  };
  safeInit('aco', initAcoLab);
  safeInit('av', initAvLab);
  safeInit('map', initMapLab);
  safeInit('deck', () => initDeck({ goTo: (v) => show(v) }));
  window.biopro = labs; // handy for console demos and automated tests

  // ---------------------------------------------------------------- tabs
  const views = ['aco', 'av', 'map', 'method', 'deck'];
  let current = null;
  function show(name, push = true) {
    if (!views.includes(name)) name = 'aco';
    if (current === name) return;
    if (current === 'aco') labs.aco?.pause();
    if (current === 'av') labs.av?.pause();
    if (current === 'map') labs.map?.onHide();
    if (current === 'deck') labs.deck?.onHide();
    current = name;
    for (const v of views) {
      const on = v === name;
      $(`#view-${v}`).classList.toggle('active', on);
      const tab = $(`#tab-${v}`);
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    if (name === 'map') labs.map?.onShow();
    if (name === 'deck') labs.deck?.onShow();
    if (name === 'method') typeset($('#view-method'));
    if (push && location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
    window.scrollTo({ top: 0 });
    window.dispatchEvent(new Event('resize'));
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => show(t.dataset.view)));
  $('.tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    if (current === 'deck') return; // arrows navigate slides while the deck is open
    const i = views.indexOf(current);
    const next = views[(i + (e.key === 'ArrowRight' ? 1 : views.length - 1)) % views.length];
    show(next);
    $(`#tab-${next}`).focus();
  });
  window.addEventListener('hashchange', () => show(location.hash.slice(1), false));
  show(location.hash.slice(1) || 'aco', false);

  initDemo(labs, show);
}

// ------------------------------------------------------------------ guided demo
function initDemo(labs, show) {
  const panel = $('#demo');
  const live = $('#demo-live');
  const actBtn = $('#demo-act');
  let idx = 0;
  let spot = null;

  const spotlight = (sel) => {
    spot?.classList.remove('spotlight');
    spot = sel ? $(sel) : null;
    if (spot) { spot.classList.add('spotlight'); spot.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  };
  const setLive = (text) => { live.hidden = !text; live.textContent = text || ''; };
  const pct = (v) => `${(v * 100).toFixed(1)}%`;

  const steps = [
    {
      title: 'How an ant makes a probabilistic decision',
      tab: 'aco',
      body: 'We load a reproducible 10-city instance (seed 42) and look at node 1. Each candidate next city <b>j</b> gets weight τ<sup>α</sup>·η<sup>β</sup>, normalised over unvisited cities. Before any learning all τ are equal, so the probabilities come only from distance (η = 1/d).',
      enter() {
        labs.aco.configure({ preset: 'random', n: 10, seed: 42, alpha: 1, beta: 3, rho: 0.1, ants: 30, maxIt: 300 });
        const eng = labs.aco.engine;
        const v = new Uint8Array(eng.n); v[0] = 1;
        const probs = eng.transitionProbabilities(0, v).sort((a, b) => b.p - a.p);
        labs.aco.select(0, probs[0].j);
        setLive(`From node 1 (live engine values):\n${probs.slice(0, 4).map((c) => `→ ${c.j + 1}: d=${eng.dist[0][c.j].toFixed(0)}  P=${pct(c.p)}`).join('\n')}`);
        return '#aco-inspector';
      },
    },
    {
      title: 'Deposit and evaporation',
      tab: 'aco',
      body: 'Press <b>Run 1 iteration</b>. All 30 ants build tours; every edge evaporates by ρ = 10 %, then each ant adds Q/L<sub>k</sub> to the edges it used. Watch the selected edge\'s τ change in the inspector — short tours deposit more.',
      action: { label: 'Run 1 iteration', run() { labs.aco.step(1); describeAcoEdge(); } },
      enter() { describeAcoEdge(); return '#aco-inspector'; },
    },
    {
      title: 'Convergence',
      tab: 'aco',
      body: 'Press <b>Run 40 iterations</b>. Positive feedback concentrates pheromone on short edges (thick, glowing gold), the best-so-far curve drops and flattens. Because n = 10 we can compute the exact optimum with Held–Karp and report the true gap — ACO is not guaranteed to reach it.',
      action: { label: 'Run 40 iterations', run() { labs.aco.step(40); describeConvergence(); } },
      enter() { describeConvergence(); return '#aco-chart'; },
    },
    {
      title: 'Antivirus: how the risk model prioritises files',
      tab: 'av',
      body: 'Infected scenario, seed 42. Ants choose files with P ∝ τ<sup>α</sup>η<sup>β</sup>, where η is a cheap triage prior (extension + folder). Each deep scan gives noisy evidence → risk R̂ = 0.45·sig + 0.35·beh + 0.20·attr. Deposit Δτ = Q(ε + R̂)·C(n), so risky files attract more ants. Press <b>Animate 1 iteration</b> to watch the 7 phases.',
      action: { label: 'Animate 1 iteration', run() { labs.av.stepAnimated(); } },
      enter() { labs.av.configure({ scenario: 'infected', seed: 42 }); setLive(''); return '#av-phase'; },
    },
    {
      title: 'Antivirus: evidence decides, pheromone prioritises',
      tab: 'av',
      body: 'Press <b>Finish the scan</b>. Confirmed threats end with the strongest trails, normal files with faint ones. The inspector shows why: classification uses only R̂ and its confidence margin — never τ. The confusion matrix and precision/recall are recomputed from the synthetic ground truth.',
      action: { label: 'Finish the scan', run() { labs.av.fastForward(200); describeAv(); } },
      enter() { describeAv(); return '#av-canvas'; },
    },
    {
      title: 'Routing: costs drive path selection',
      tab: 'map',
      body: 'Bandra West → CSMT on real OSM roads, objective = lowest estimated time. Ants walk the road graph; η = 1/(edge cost + straight-line lower bound). Press <b>Run 40 iterations</b> and compare with Dijkstra, which uses the identical graph and costs.',
      action: { label: 'Run 40 iterations', async run() { labs.map.step(40); describeMap(); } },
      async enter() { setLive('Loading road network…'); await labs.map.configure({ origin: 'Bandra West', dest: 'CSMT / Fort', objective: 'time', seed: 7, maxIt: 200 }); describeMap(); return '#map-verdict'; },
    },
    {
      title: 'Routing: congestion changes the optimum',
      tab: 'map',
      body: 'Press <b>Congest the Sea Link</b> (simulated ×4 travel time). Dijkstra is recomputed instantly; ACO keeps its pheromone, re-prices its best route, and must re-learn through new deposits and evaporation. Then run more iterations and see whether it adapts.',
      action: {
        label: 'Congest the Sea Link',
        run() {
          const name = labs.map.congestCorridor(/sea link/i, 4) || labs.map.congestCorridor(/western express|eastern express/i, 4);
          labs.map.step(30);
          describeMap(name ? `Congested: ${name} ×4 (simulated)` : 'No Sea Link corridor in data');
        },
      },
      enter() { describeMap(); return '#map-congest'; },
    },
  ];

  function describeAcoEdge() {
    const e = labs.aco.describeEdge();
    if (!e) return;
    const h = e.history;
    setLive(`Edge ${e.i + 1}–${e.j + 1} after iteration ${labs.aco.engine.iteration}:\nτ = ${e.tau.toExponential(3)}  d = ${e.distance.toFixed(0)}\nlast deposit = ${e.lastDeposit.toExponential(2)} from ${e.lastAnts} ants${h.length > 1 ? `\nτ before → after: ${h.at(-2).tau.toExponential(3)} → ${h.at(-1).tau.toExponential(3)}` : ''}`);
  }
  function describeConvergence() {
    const eng = labs.aco.engine; const s = labs.aco.state;
    if (!eng.best) { setLive(''); return; }
    const gap = s.optimum ? ((eng.best.length - s.optimum.length) / s.optimum.length) * 100 : null;
    setLive(`Iteration ${eng.iteration}: best-so-far ${eng.best.length.toFixed(1)} (found at it ${eng.best.iteration})\n${s.optimum ? `exact optimum ${s.optimum.length.toFixed(1)} → gap ${gap.toFixed(2)}%` : ''}`);
  }
  function describeAv() {
    const eng = labs.av.engine;
    const m = eng.metrics();
    const mal = eng.files.filter((f) => f.status === STATUS.MALICIOUS);
    if (mal[0]) labs.av.select(mal[0].id);
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN);
    const tau = (pred) => avg(eng.files.filter(pred).map((f) => f.tau));
    setLive(`Iteration ${eng.iteration}: TP ${m.tp} FP ${m.fp} FN ${m.fn} TN ${m.tn}\nprecision ${m.precision == null ? 'undefined' : pct(m.precision)}  recall ${m.recall == null ? 'undefined' : pct(m.recall)}\nmean τ — malicious: ${tau((f) => f.status === STATUS.MALICIOUS).toFixed(2)}, suspicious: ${tau((f) => f.status === STATUS.SUSPICIOUS).toFixed(2)}, clean: ${tau((f) => f.status === STATUS.CLEAN).toFixed(2)}`);
  }
  function describeMap(extra = '') {
    const st = labs.map.state;
    const a = st.aco;
    if (!a || !st.dij) { setLive(extra); return; }
    const best = a.best ? `${(a.best.cost / 60).toFixed(2)} min` : '—';
    setLive(`${extra ? `${extra}\n` : ''}Iteration ${a.iteration}: ACO best ${best}  ·  Dijkstra ${(st.dij.cost / 60).toFixed(2)} min${a.best ? `\ngap ${(((a.best.cost - st.dij.cost) / st.dij.cost) * 100).toFixed(2)}%` : ''}`);
  }

  async function go(i) {
    idx = Math.max(0, Math.min(steps.length - 1, i));
    const s = steps[idx];
    show(s.tab);
    $('#demo-n').textContent = `STEP ${idx + 1} OF ${steps.length}`;
    $('#demo-title').textContent = s.title;
    $('#demo-body').innerHTML = s.body;
    $('#demo-dots').innerHTML = steps.map((_, k) => `<i class="${k === idx ? 'on' : ''}"></i>`).join('');
    $('#demo-prev').disabled = idx === 0;
    $('#demo-next').querySelector('span').textContent = idx === steps.length - 1 ? 'Finish' : 'Next';
    actBtn.hidden = !s.action;
    if (s.action) actBtn.textContent = s.action.label;
    setLive('');
    try {
      const sel = await s.enter?.();
      spotlight(sel);
    } catch (err) {
      setLive(`This step could not run: ${err.message}`);
    }
  }
  actBtn.addEventListener('click', async () => {
    actBtn.disabled = true;
    try { await steps[idx].action.run(); } catch (err) { setLive(`Error: ${err.message}`); }
    actBtn.disabled = false;
  });
  $('#demo-open').addEventListener('click', () => { panel.hidden = false; go(0); });
  $('#demo-close').addEventListener('click', () => { panel.hidden = true; spotlight(null); });
  $('#demo-prev').addEventListener('click', () => go(idx - 1));
  $('#demo-next').addEventListener('click', () => { if (idx === steps.length - 1) { panel.hidden = true; spotlight(null); } else go(idx + 1); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { panel.hidden = true; spotlight(null); } });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
