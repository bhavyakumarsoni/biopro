// Lab 3 — Mumbai road routing: PathAco vs Dijkstra on the same OSM-derived graph.

import { randomSeed } from '../core/rng.js';
import { dijkstra } from '../core/graph.js';
import { PathAco } from '../core/path-aco.js';
import { RoadNetwork, LANDMARKS, OBJECTIVES } from '../core/roadgraph.js';
import { $, fmt, bindRange, bindSeg, setPill, drawSparkline, Runner, escapeHtml } from './util.js';
import { lineChart, setSeries } from './charts.js';
import { tileProviderChain } from '../config.js';

const PERIOD_MS = [0, 1600, 1000, 600, 320, 120];
const MUMBAI_CENTER = [19.06, 72.875];

export function initMapLab() {
  const statusEl = $('#map-status');
  const startBtn = $('#map-start');
  const st = {
    net: null, map: null, canvas: null, aco: null,
    objective: 'time', seed: 7, speed: 3, maxIt: 80,
    origin: null, dest: null, // {node, label, snap}
    dij: null, dijMs: 0, acoMs: 0,
    phase: 'loading', lastStepAt: 0, animStart: 0,
    selectedSeg: null, clickCongest: false,
    tileErrors: 0, tileLoaded: 0, initialised: false, visible: false,
    projCache: null,
  };
  const params = { alpha: 1, beta: 1.5, rho: 0.1, ants: 30 };
  let chart = null;

  // ------------------------------------------------------------- data loading
  // data/mumbai-roads.js (a plain script) sets window.MUMBAI_ROADS so the site also works when
  // index.html is opened straight from disk; otherwise fall back to fetching the JSON file.
  const dataPromise = (window.MUMBAI_ROADS
    ? Promise.resolve(window.MUMBAI_ROADS)
    : fetch('data/mumbai-roads.json').then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status} while loading data/mumbai-roads.json`); return r.json(); }))
    .then((d) => { st.net = new RoadNetwork(d); return st.net; })
    .catch((err) => { console.warn('[map] road data unavailable:', err.message); showMessage(`<b>Road network could not be loaded.</b><br>${escapeHtml(err.message)}<br><span class="hint">Check that <span class="mono">data/mumbai-roads.js</span> is deployed next to index.html.</span>`, true); setPill(statusEl, 'error', 'Data error'); throw err; });
  dataPromise.catch(() => {}); // handled above; avoid an unhandled-rejection console error

  function showMessage(html, isErr = false) {
    const m = $('#map-msg');
    $('#map-msg-box').innerHTML = html;
    $('#map-msg-box').className = `box${isErr ? ' banner err' : ''}`;
    m.hidden = false;
  }
  function hideMessage() { $('#map-msg').hidden = true; }

  // ------------------------------------------------------------- controls
  bindRange($('#map-alpha'), $('#map-alpha-v'), (v) => { params.alpha = v; st.aco?.setParams({ alpha: v }); }, (v) => v.toFixed(1));
  bindRange($('#map-beta'), $('#map-beta-v'), (v) => { params.beta = v; st.aco?.setParams({ beta: v }); }, (v) => v.toFixed(1));
  bindRange($('#map-rho'), $('#map-rho-v'), (v) => { params.rho = v; st.aco?.setParams({ rho: v }); }, (v) => v.toFixed(2));
  bindRange($('#map-ants'), $('#map-ants-v'), (v) => { params.ants = v; st.aco?.setParams({ ants: v }); }, String);
  bindRange($('#map-speed'), $('#map-speed-v'), (v) => { st.speed = v; }, (v) => ['', 'slow', 'calm', 'normal', 'fast', 'turbo'][v]);
  bindRange($('#map-maxit'), $('#map-maxit-v'), (v) => { st.maxIt = v; if (st.phase === 'done' && st.aco && st.aco.iteration < v) setPhase('paused'); }, String);
  const multInput = bindRange($('#map-mult'), $('#map-mult-v'), () => {}, (v) => `×${v.toFixed(1)}`);
  const objSeg = bindSeg($('#map-objective'), (v) => { st.objective = v; setupRun(); });
  const seedInput = $('#map-seed');
  seedInput.addEventListener('change', () => {
    const v = Math.floor(Number(seedInput.value));
    if (!(v >= 1 && v <= 999999999)) { seedInput.value = st.seed; return; }
    st.seed = v; setupRun();
  });
  $('#map-dice').addEventListener('click', () => { st.seed = randomSeed(); seedInput.value = st.seed; setupRun(); });
  startBtn.addEventListener('click', () => (runner.running ? pause() : start()));
  $('#map-step').addEventListener('click', () => { pause(); doStep(); });
  $('#map-reset').addEventListener('click', () => setupRun());
  $('#map-swap').addEventListener('click', () => {
    const o = $('#map-origin').value; $('#map-origin').value = $('#map-dest').value; $('#map-dest').value = o;
    [st.origin, st.dest] = [st.dest, st.origin];
    setupRun();
  });
  $('#map-click-congest').addEventListener('change', (e) => { st.clickCongest = e.target.checked; });
  $('#map-congest').addEventListener('click', () => {
    if (!st.net) return;
    const name = $('#map-corridor').value;
    const ids = st.net.segmentsByName(name);
    const m = Number($('#map-mult').value);
    ids.forEach((id) => st.net.setCongestion(id, m));
    congestionChanged(`${name} ×${m}`);
  });
  $('#map-clear').addEventListener('click', () => { if (!st.net) return; st.net.clearCongestion(); congestionChanged('cleared'); });

  for (const id of ['#map-origin', '#map-dest']) {
    $(id).addEventListener('change', (e) => {
      const ep = resolvePlace(e.target.value);
      if (!ep) { $('#map-snap').textContent = `"${e.target.value}" is not in the locality list — pick a suggestion or click a junction on the map.`; return; }
      e.target.value = ep.label;
      if (id === '#map-origin') st.origin = ep; else st.dest = ep;
      setupRun();
    });
  }

  function resolvePlace(text) {
    if (!st.net) return null;
    const t = text.trim().toLowerCase();
    if (!t) return null;
    const lm = LANDMARKS.find((l) => l.name.toLowerCase() === t) || LANDMARKS.find((l) => l.name.toLowerCase().startsWith(t)) || LANDMARKS.find((l) => l.name.toLowerCase().includes(t));
    if (!lm) return null;
    const { node, distance } = st.net.nearestNode(lm.lat, lm.lng);
    return { node, label: lm.name, snap: distance };
  }

  // ------------------------------------------------------------- map setup (lazy: needs a visible container)
  async function ensureMap() {
    if (st.initialised) { st.map.invalidateSize(); draw(); return; }
    st.initialised = true;
    if (!window.L) {
      showMessage('<b>The map library (Leaflet) failed to load.</b><br>Check that <span class="mono">vendor/leaflet/leaflet.js</span> is deployed.', true);
      setPill(statusEl, 'error', 'Map error');
      return;
    }
    const L = window.L;
    const map = L.map('map', { zoomControl: true, zoomAnimation: false, fadeAnimation: true, preferCanvas: true, minZoom: 10, maxZoom: 17 }).setView(MUMBAI_CENTER, 12);
    st.map = map;
    // basemap with automatic fallback: [MapTiler if a key is configured] → CARTO → OpenStreetMap
    const chain = tileProviderChain();
    const useProvider = (k) => {
      if (st.tiles) map.removeLayer(st.tiles);
      st.providerIdx = k; st.tileErrors = 0; st.tileLoaded = 0;
      const pv = chain[k];
      const tiles = L.tileLayer(pv.url, { ...pv.options, attribution: `${pv.options.attribution} · road graph: OSM (ODbL)` });
      $('#map').classList.toggle('dark-tiles', !!pv.dark);
      tiles.on('tileerror', () => {
        st.tileErrors++;
        if (st.tileErrors >= 6 && st.tileLoaded === 0) {
          if (st.providerIdx < chain.length - 1) { console.warn(`[map] ${pv.name} tiles unavailable, trying ${chain[st.providerIdx + 1].name}`); useProvider(st.providerIdx + 1); return; }
          if (!$('#map-tiles-warn')) {
            const b = document.createElement('div');
            b.id = 'map-tiles-warn';
            b.className = 'banner warn';
            b.style.cssText = 'position:absolute;right:12px;top:12px;z-index:700;max-width:300px;padding:8px 10px';
            b.innerHTML = '<span>No internet for the background map. Roads, ants and routing still work from the bundled OpenStreetMap data.</span>';
            $('#map').parentElement.append(b);
          }
        }
      });
      tiles.on('tileload', () => { st.tileLoaded++; $('#map-tiles-warn')?.remove(); });
      tiles.addTo(map);
      st.tiles = tiles;
    };
    useProvider(0);

    // overlay canvas for roads / pheromone / ants
    const c = document.createElement('canvas');
    c.style.cssText = 'position:absolute;inset:0;z-index:400;pointer-events:none;width:100%;height:100%';
    $('#map').append(c);
    st.canvas = c;
    map.on('move zoom resize viewreset', () => { st.projCache = null; draw(); });
    map.on('click', onMapClick);

    st.markerLayer = L.layerGroup().addTo(map);
    try { await dataPromise; } catch { return; }
    hideMessage();
    populateControls();
    st.origin = st.origin || resolvePlace('Bandra West');
    st.dest = st.dest || resolvePlace('CSMT / Fort');
    $('#map-origin').value = st.origin.label;
    $('#map-dest').value = st.dest.label;
    setupRun();
  }

  function populateControls() {
    const net = st.net;
    $('#map-places').innerHTML = LANDMARKS.map((l) => `<option value="${escapeHtml(l.name)}"></option>`).join('');
    const sel = $('#map-corridor');
    sel.innerHTML = net.corridors(40).map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)} (${(c.length / 1000).toFixed(1)} km)</option>`).join('');
    const pref = [...sel.options].find((o) => /sea link/i.test(o.value)) || [...sel.options].find((o) => /western express/i.test(o.value));
    if (pref) sel.value = pref.value;
    const m = net.meta;
    $('#map-graph').innerHTML = `${fmt.int(net.nodes.length)} <small>junctions</small>`;
    $('#map-data-desc').innerHTML = `<strong>${fmt.int(net.nodes.length)} junctions</strong> and <strong>${fmt.int(net.segments.length)} road segments</strong> (${fmt.int(net.graph.edges.length)} directed edges) from OpenStreetMap, ${escapeHtml(m.source || '')}. OSM snapshot: ${escapeHtml(m.osmTimestamp || 'unknown')}. Bounding box ${m.bbox ? m.bbox.join(', ') : ''}. ${escapeHtml(m.license || '')}.`;
    const mc = document.getElementById('m-data-counts');
    if (mc) mc.textContent = `The bundled graph has ${net.nodes.length} junctions and ${net.segments.length} segments (OSM snapshot ${m.osmTimestamp || 'unknown'}).`;
  }

  // ------------------------------------------------------------- algorithm setup
  function setupRun() {
    pause();
    if (!st.net || !st.origin || !st.dest) return;
    if (st.origin.node === st.dest.node) {
      setPhase('error', 'Origin = destination');
      $('#map-verdict').className = 'verdict worse';
      $('#map-verdict').textContent = 'Origin and destination snap to the same junction. Choose two different places.';
      st.aco = null; st.dij = null; draw(); renderPanels();
      return;
    }
    const net = st.net;
    st.aco = new PathAco(net.graph, net.costFn(st.objective), net.heuristicFn(st.objective), params, st.seed);
    st.aco.setEndpoints(st.origin.node, st.dest.node, st.seed);
    st.acoMs = 0;
    runDijkstra();
    $('#map-snap').textContent = `Origin snapped to a junction ${fmt.int(st.origin.snap)} m from ${st.origin.label}; destination ${fmt.int(st.dest.snap)} m from ${st.dest.label}.`;
    $('#map-obj-label').textContent = `objective: ${OBJECTIVES[st.objective].label}`;
    $('#map-chart-unit').textContent = st.objective === 'time' ? 'estimated minutes' : 'kilometres';
    if (!chart) {
      chart = lineChart($('#map-chart'), [
        { label: 'ACO best-so-far', color: '#2dd4bf', width: 2.4 },
        { label: 'iteration best', color: '#ffd23f', width: 1.3 },
        { label: 'average ant', color: '#8b8b9a', width: 1.1, dash: [4, 3] },
      ], { yTitle: '', refLine: { label: 'Dijkstra optimum', color: '#ffffff' } });
    }
    placeMarkers();
    fitToRoute();
    setPhase('idle');
    renderPanels();
    draw();
  }

  function fitToRoute() {
    if (!st.map || !window.L) return;
    const pts = [st.net.nodes[st.origin.node], st.net.nodes[st.dest.node]];
    if (st.dij?.edges) for (const ei of st.dij.edges) pts.push(st.net.nodes[st.net.graph.edges[ei].v]);
    st.map.invalidateSize();
    st.map.fitBounds(window.L.latLngBounds(pts).pad(0.25), { maxZoom: 15 });
  }

  function runDijkstra() {
    const t0 = performance.now();
    st.dij = dijkstra(st.net.graph, st.net.costFn(st.objective), st.origin.node, st.dest.node);
    st.dijMs = performance.now() - t0;
  }

  function congestionChanged(label) {
    const n = Array.from(st.net.congestion).filter((m) => m > 1).length;
    const names = [...new Set(st.net.segments.filter((s) => st.net.congestion[s.id] > 1).map((s) => s.name || '(unnamed)'))];
    $('#map-congest-info').textContent = n ? `${n} segment(s) congested: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` +${names.length - 4} more` : ''}.` : 'No congestion applied.';
    if (st.aco) {
      st.aco.costsChanged(`congestion ${label}`);
      runDijkstra();
      if (st.objective === 'distance') {
        $('#map-congest-info').textContent += ' Objective is distance, so the optimal route is unchanged (congestion only alters time).';
      }
      if (st.phase === 'done' && st.aco.iteration < st.maxIt) setPhase('paused');
    }
    renderPanels();
    draw();
  }

  // ------------------------------------------------------------- run loop
  function doStep() {
    if (!st.aco) return false;
    if (st.aco.iteration >= st.maxIt) { setPhase('done'); return false; }
    const t0 = performance.now();
    st.aco.step();
    st.acoMs += performance.now() - t0;
    st.animStart = performance.now();
    if (st.aco.iteration >= st.maxIt) setPhase('done');
    else if (!runner.running) setPhase('paused');
    renderPanels();
    draw();
    return true;
  }
  const runner = new Runner((t) => {
    if (t - st.lastStepAt >= PERIOD_MS[st.speed]) {
      st.lastStepAt = t;
      if (!doStep()) { pause(); return false; }
    }
    draw();
    return true;
  });
  function start() {
    if (!st.aco) return;
    if (st.aco.iteration >= st.maxIt) { setPhase('done'); return; }
    setPhase('running');
    runner.start();
  }
  function pause() {
    const was = runner.running;
    runner.stop();
    if (was && st.phase === 'running') setPhase('paused');
  }
  function setPhase(p, msg) {
    st.phase = p;
    const lab = { idle: 'Ready', running: 'Running', paused: 'Paused', done: 'Completed', error: msg || 'Error', loading: 'Loading data…' };
    setPill(statusEl, p === 'idle' ? '' : p, lab[p]);
    const text = p === 'running' ? 'Pause' : st.aco && st.aco.iteration > 0 && p !== 'done' ? 'Resume' : 'Run';
    startBtn.innerHTML = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${p === 'running' ? '<path d="M8 4v16M16 4v16"/>' : '<path d="M7 4v16l13-8z"/>'}</svg><span>${text}</span>`;
    startBtn.disabled = p === 'done' || p === 'error';
  }

  // ------------------------------------------------------------- panels
  const costLabel = (c) => (st.objective === 'time' ? fmt.min(c) : fmt.km(c));
  function renderPanels() {
    const a = st.aco;
    $('#map-it').textContent = a ? a.iteration : 0;
    $('#map-best').textContent = a?.best ? costLabel(a.best.cost) : '—';
    $('#map-dij').textContent = st.dij && st.dij.edges ? costLabel(st.dij.cost) : '—';
    const last = a?.last;
    $('#map-avg').textContent = last && Number.isFinite(last.avg) ? costLabel(last.avg) : '—';
    $('#map-succ').textContent = last ? `${last.routes.length} / ${last.routes.length + last.failed}` : '—';
    const net = st.net;
    const fill = (pfx, edges, ms) => {
      if (!edges) { ['d', 't', 'e', 'ms'].forEach((k) => { $(`#r-${pfx}-${k}`).textContent = '—'; }); return; }
      const m = net.routeMetrics(edges);
      $(`#r-${pfx}-d`).textContent = fmt.km(m.distance);
      $(`#r-${pfx}-t`).textContent = fmt.min(m.time);
      $(`#r-${pfx}-e`).textContent = m.edges;
      $(`#r-${pfx}-ms`).textContent = fmt.ms(ms);
    };
    fill('aco', a?.best?.edges, st.acoMs);
    fill('dij', st.dij?.edges, st.dijMs);
    const v = $('#map-verdict');
    if (a?.best && st.dij?.edges) {
      const gap = (a.best.cost - st.dij.cost) / st.dij.cost;
      const same = a.best.edges.length === st.dij.edges.length && a.best.edges.every((e, i) => e === st.dij.edges[i]);
      if (same || Math.abs(gap) < 1e-9) {
        v.className = 'verdict match';
        v.textContent = `ACO's best route ${same ? 'is identical to' : 'has the same cost as'} the Dijkstra optimum (${costLabel(st.dij.cost)}), found by iteration ${a.best.iteration} of ${a.iteration}.`;
      } else if (gap > 0) {
        v.className = 'verdict worse';
        v.textContent = `ACO's best route is ${(gap * 100).toFixed(2)}% worse than the Dijkstra optimum (${costLabel(a.best.cost)} vs ${costLabel(st.dij.cost)}) after ${a.iteration} iterations. ACO is a stochastic heuristic; more iterations or different α/β/ρ may close the gap.`;
      } else {
        v.className = 'verdict worse';
        v.textContent = 'ACO reports a lower cost than Dijkstra — this should be impossible on identical costs and indicates a bug.';
      }
      const ev = a.history.events;
      if (ev.length) v.textContent += ` Costs changed at iteration ${ev.map((e) => e.iteration).join(', ')} (${ev.at(-1).label}); both routes are priced under current costs.`;
    } else if (a && st.dij?.edges) {
      v.className = 'verdict';
      v.textContent = `Dijkstra optimum: ${costLabel(st.dij.cost)} (settled ${fmt.int(st.dij.settled)} junctions). Press Run or Step to start the colony.`;
    } else if (st.dij && !st.dij.edges) {
      v.className = 'verdict worse';
      v.textContent = 'No route exists between these junctions in the graph.';
    }
    if (chart && a) {
      const conv = st.objective === 'time' ? (x) => x / 60 : (x) => x / 1000;
      setSeries(chart, [a.history.best.map(conv), a.history.iterBest.map(conv), a.history.avg.map(conv)], st.dij?.edges ? conv(st.dij.cost) : null);
    }
    renderInspector();
  }

  function renderInspector() {
    const box = $('#map-inspector');
    const sid = st.selectedSeg;
    if (sid == null || !st.net) return;
    const net = st.net; const s = net.segments[sid];
    const dirEdges = net.graph.edges.map((e, i) => (e.seg === sid ? i : -1)).filter((i) => i >= 0);
    const rows = dirEdges.map((ei) => {
      const e = net.graph.edges[ei];
      const tau = st.aco ? st.aco.tau[ei] : null;
      const cost = net.costFn(st.objective)(ei);
      return { ei, e, tau, cost, hist: st.aco ? st.aco.edgeHistory(ei) : [] };
    });
    const main = rows.reduce((a, b) => ((b.tau ?? 0) > (a.tau ?? 0) ? b : a), rows[0]);
    const tmax = st.aco ? st.aco.maxTau() : 1;
    box.innerHTML = `
      <div class="mono" style="font-size:14px;color:var(--text)">${escapeHtml(s.name || '(unnamed road)')}</div>
      <div class="hint">${escapeHtml(net.meta.highwayClasses?.[s.cls] || '')} · ${s.oneway ? 'one-way' : 'two-way'} · segment #${sid}</div>
      <dl class="kv" style="margin-top:10px">
        <dt>Length</dt><dd>${fmt.n(s.length, 0)} m</dd>
        <dt>Free-flow speed</dt><dd>${s.speed} km/h ${s.speedTagged ? '(OSM maxspeed)' : '(assumed class default)'}</dd>
        <dt>Congestion multiplier</dt><dd style="color:${net.congestion[sid] > 1 ? '#fda4af' : 'inherit'}">×${net.congestion[sid].toFixed(1)} ${net.congestion[sid] > 1 ? '(simulated)' : ''}</dd>
        <dt>Est. travel time</dt><dd>${fmt.n(net.edgeTime(dirEdges[0]), 1)} s</dd>
        <dt>Current cost (${st.objective})</dt><dd>${st.objective === 'time' ? `${fmt.n(main.cost, 1)} s` : `${fmt.n(main.cost, 0)} m`}</dd>
        ${rows.map((r) => `<dt>τ ${r.e.rev ? 'reverse' : 'forward'} direction</dt><dd>${r.tau == null ? '—' : `${fmt.sci(r.tau)} (${((r.tau / tmax) * 100).toFixed(0)}%)`}</dd>`).join('')}
        <dt>In ACO best / Dijkstra</dt><dd>${dirEdges.some((e) => st.aco?.best?.edges.includes(e)) ? 'yes' : 'no'} / ${dirEdges.some((e) => st.dij?.edges?.includes(e)) ? 'yes' : 'no'}</dd>
      </dl>
      <div class="hint" style="margin-top:10px">τ history (${main.hist.length} iterations, ${main.e.rev ? 'reverse' : 'forward'} direction; deposits marked)</div>
      <canvas class="spark" id="map-spark"></canvas>
      <div style="margin-top:8px"><button class="btn sm" id="map-toggle-seg">${net.congestion[sid] > 1 ? 'Clear congestion on this road' : `Congest this road ×${Number($('#map-mult').value).toFixed(1)}`}</button></div>`;
    drawSparkline($('#map-spark'), main.hist.map((h) => h.tau), { marks: main.hist.map((h, i) => (h.dep > 0 ? { i } : null)).filter(Boolean) });
    $('#map-toggle-seg').addEventListener('click', () => toggleSegCongestion(sid));
  }

  function toggleSegCongestion(sid) {
    const cur = st.net.congestion[sid];
    st.net.setCongestion(sid, cur > 1 ? 1 : Number($('#map-mult').value));
    congestionChanged(`${st.net.segments[sid].name || 'road'} ${cur > 1 ? 'cleared' : `×${$('#map-mult').value}`}`);
  }

  // ------------------------------------------------------------- markers & clicks
  function placeMarkers() {
    const L = window.L;
    if (!L || !st.markerLayer) return;
    st.markerLayer.clearLayers();
    for (const [ep, cls, color] of [[st.origin, 'o', '#34d399'], [st.dest, 'd', '#ffd23f']]) {
      if (!ep) continue;
      L.circleMarker(st.net.nodes[ep.node], { radius: 8, color: '#09090b', weight: 2, fillColor: color, fillOpacity: 1 })
        .bindTooltip(`${cls === 'o' ? 'Origin' : 'Destination'}: ${escapeHtml(ep.label)}`, { permanent: true, direction: 'top', className: `map-label ${cls}`, offset: [0, -8] })
        .addTo(st.markerLayer);
    }
  }

  function projectAll() {
    if (st.projCache) return st.projCache;
    const map = st.map; const net = st.net;
    const segs = net.segments.map((s) => net.segmentLatLngs(s.id).map((ll) => map.latLngToContainerPoint(ll)));
    st.projCache = { segs };
    return st.projCache;
  }

  function onMapClick(ev) {
    if (!st.net) return;
    const p = ev.containerPoint;
    const { segs } = projectAll();
    // nearest junction first
    let bn = -1; let bnd = 9;
    st.net.nodes.forEach((ll, i) => { const q = st.map.latLngToContainerPoint(ll); const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bnd) { bnd = d; bn = i; } });
    if (bn >= 0 && !st.clickCongest) {
      const L = window.L;
      const div = document.createElement('div');
      div.innerHTML = `<div style="font-weight:600;margin-bottom:6px">Junction #${bn}</div><div style="display:flex;gap:6px"><button class="btn sm" data-a="o">Set origin</button><button class="btn sm" data-a="d">Set destination</button></div>`;
      const popup = L.popup().setLatLng(st.net.nodes[bn]).setContent(div).openOn(st.map);
      div.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        const ep = { node: bn, label: `Junction #${bn}`, snap: 0 };
        if (b.dataset.a === 'o') { st.origin = ep; $('#map-origin').value = ep.label; } else { st.dest = ep; $('#map-dest').value = ep.label; }
        st.map.closePopup(popup);
        setupRun();
      }));
      return;
    }
    let best = -1; let bd = 8;
    segs.forEach((pts, sid) => {
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1]; const b = pts[k];
        const dx = b.x - a.x; const dy = b.y - a.y; const L2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
        const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
        if (d < bd) { bd = d; best = sid; }
      }
    });
    if (best < 0) return;
    st.selectedSeg = best;
    if (st.clickCongest) toggleSegCongestion(best);
    renderInspector();
    draw();
  }

  // ------------------------------------------------------------- drawing
  function draw() {
    const c = st.canvas; const map = st.map;
    if (!c || !map || !st.net) return;
    const size = map.getSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (c.width !== Math.round(size.x * dpr) || c.height !== Math.round(size.y * dpr)) { c.width = Math.round(size.x * dpr); c.height = Math.round(size.y * dpr); }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);
    const { segs } = projectAll();
    const net = st.net; const aco = st.aco;
    const zoom = map.getZoom();
    const line = (pts) => { ctx.beginPath(); pts.forEach((q, k) => (k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); };
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // base network
    ctx.strokeStyle = 'rgba(120,120,140,0.45)';
    ctx.lineWidth = zoom >= 14 ? 1.6 : 1;
    for (const pts of segs) { line(pts); ctx.stroke(); }
    // congestion
    ctx.strokeStyle = 'rgba(244,63,94,0.85)'; ctx.lineWidth = 3.5;
    net.segments.forEach((s) => { if (net.congestion[s.id] > 1) { line(segs[s.id]); ctx.stroke(); } });
    // pheromone (both directions of a segment combined with max)
    if (aco && aco.touched.size) {
      const tmax = aco.maxTau() || 1;
      const segTau = new Map();
      for (const ei of aco.touched) { const sid = net.graph.edges[ei].seg; segTau.set(sid, Math.max(segTau.get(sid) || 0, aco.tau[ei])); }
      const list = [...segTau.entries()].map(([sid, t]) => [sid, t / tmax]).filter(([, r]) => r > 0.015).sort((a, b) => a[1] - b[1]);
      for (const [sid, r] of list) {
        line(segs[sid]);
        ctx.lineWidth = 1 + 6 * r;
        ctx.strokeStyle = `rgba(255,210,63,${0.18 + 0.8 * r})`;
        if (r > 0.6) { ctx.shadowColor = '#ffd23f'; ctx.shadowBlur = 12 * r; } else ctx.shadowBlur = 0;
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }
    // Dijkstra optimum (white dashed) and ACO best (teal)
    const drawRoute = (edges, color, width, dash) => {
      if (!edges) return;
      ctx.beginPath();
      edges.forEach((ei, k) => {
        const pts = net.edgeLatLngs(ei).map((ll) => map.latLngToContainerPoint(ll));
        pts.forEach((q, j) => (k === 0 && j === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)));
      });
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]);
    };
    drawRoute(aco?.best?.edges, '#2dd4bf', 3, []);
    drawRoute(st.dij?.edges, 'rgba(255,255,255,0.9)', 1.6, [6, 6]);
    // selected segment
    if (st.selectedSeg != null) { line(segs[st.selectedSeg]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 5; ctx.globalAlpha = 0.5; ctx.stroke(); ctx.globalAlpha = 1; }
    // ants of the last iteration, moving along their actual routes
    const last = aco?.last;
    if (last && last.routes.length) {
      const p = Math.min(1, (performance.now() - st.animStart) / Math.max(400, PERIOD_MS[st.speed] * 0.95));
      ctx.fillStyle = '#ffffff';
      for (const r of last.routes.slice(0, 40)) {
        const pos = antPosition(r.edges, p);
        if (pos) { const q = map.latLngToContainerPoint(pos); ctx.beginPath(); ctx.arc(q.x, q.y, 3, 0, Math.PI * 2); ctx.fill(); }
      }
      if (p < 1 && !runner.running) requestAnimationFrame(draw);
    }
  }

  function antPosition(edges, p) {
    // position at fraction p of the route's length (cached per route)
    const key = edges;
    let poly = antPosition.cache.get(key);
    if (!poly) {
      const pts = [];
      edges.forEach((ei, k) => { const ll = st.net.edgeLatLngs(ei); (k ? ll.slice(1) : ll).forEach((q) => pts.push(q)); });
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], (pts[i][1] - pts[i - 1][1]) * 0.946));
      poly = { pts, cum };
      antPosition.cache.set(key, poly);
    }
    const total = poly.cum.at(-1);
    if (!total) return poly.pts[0];
    const target = total * p;
    let i = 1;
    while (i < poly.cum.length && poly.cum[i] < target) i++;
    if (i >= poly.pts.length) return poly.pts.at(-1);
    const f = (target - poly.cum[i - 1]) / (poly.cum[i] - poly.cum[i - 1] || 1);
    return [poly.pts[i - 1][0] + (poly.pts[i][0] - poly.pts[i - 1][0]) * f, poly.pts[i - 1][1] + (poly.pts[i][1] - poly.pts[i - 1][1]) * f];
  }
  antPosition.cache = new WeakMap();

  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

  return {
    onShow() { st.visible = true; ensureMap(); },
    onHide() { st.visible = false; pause(); },
    get state() { return st; },
    ready: dataPromise,
    async configure({ origin, dest, objective, seed, alpha, beta, ants, maxIt }) {
      await ensureMap();
      await dataPromise;
      pause();
      if (objective) { st.objective = objective; objSeg.set(objective, false); }
      if (seed) { st.seed = seed; seedInput.value = seed; }
      if (maxIt) { st.maxIt = maxIt; $('#map-maxit').value = maxIt; $('#map-maxit-v').textContent = maxIt; }
      if (alpha != null) { params.alpha = alpha; $('#map-alpha').value = alpha; $('#map-alpha-v').textContent = alpha.toFixed(1); }
      if (beta != null) { params.beta = beta; $('#map-beta').value = beta; $('#map-beta-v').textContent = beta.toFixed(1); }
      if (ants != null) { params.ants = ants; $('#map-ants').value = ants; $('#map-ants-v').textContent = ants; }
      if (origin) { st.origin = resolvePlace(origin); $('#map-origin').value = st.origin.label; }
      if (dest) { st.dest = resolvePlace(dest); $('#map-dest').value = st.dest.label; }
      setupRun();
    },
    step(k = 1) { pause(); for (let i = 0; i < k; i++) if (!doStep()) break; },
    start,
    pause,
    congestCorridor(regex, mult = 4) {
      const name = [...$('#map-corridor').options].map((o) => o.value).find((n) => regex.test(n));
      if (!name) return null;
      st.net.segmentsByName(name).forEach((id) => st.net.setCongestion(id, mult));
      $('#map-corridor').value = name;
      multInput(mult);
      congestionChanged(`${name} ×${mult}`);
      return name;
    },
    clearCongestion() { st.net.clearCongestion(); congestionChanged('cleared'); },
  };
}
