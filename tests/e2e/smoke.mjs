// Browser end-to-end check (Playwright). Usage:
//   npm run serve &   then   node tests/e2e/smoke.mjs [baseUrl] [screenshotDir]
// Exercises every major control and fails on console errors, broken stats or horizontal overflow.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // devDependency; globally available in CI images

const base = process.argv[2] || 'http://localhost:5173/';
const shots = process.argv[3] || null;
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => window.biopro && window.biopro.aco && window.biopro.av);
const txt = (sel) => page.locator(sel).innerText();

// ---------------- ACO lab
check('ACO: initial iteration is 0', (await txt('#aco-it')) === '0');
await page.click('#aco-step');
check('ACO: Step runs exactly one iteration', (await txt('#aco-it')) === '1');
await page.click('#aco-start');
await page.waitForTimeout(1500);
const itRunning = Number(await txt('#aco-it'));
check('ACO: Start runs iterations', itRunning > 3, `iteration ${itRunning}`);
check('ACO: status shows Running', (await txt('#aco-status')) === 'Running');
await page.click('#aco-start'); // pause
const itPaused = Number(await txt('#aco-it'));
await page.waitForTimeout(600);
check('ACO: Pause stops iterations', Number(await txt('#aco-it')) === itPaused);
check('ACO: Resume label after pause', (await txt('#aco-start')).includes('Resume'));
check('ACO: best distance shown', /\d/.test(await txt('#aco-best')));
check('ACO: exact optimum computed for n=12', /\d/.test(await txt('#aco-opt')));
const gap = parseFloat(await txt('#aco-gap'));
check('ACO: gap to optimum is non-negative', gap >= -1e-9, `${gap}%`);
await page.click('#aco-reset');
check('ACO: Reset returns to iteration 0', (await txt('#aco-it')) === '0' && (await txt('#aco-best')) === '—');
// parameters affect engine
await page.locator('#aco-alpha').fill('3.5');
await page.locator('#aco-ants').fill('7');
const p = await page.evaluate(() => window.biopro.aco.engine.params);
check('ACO: α and ant sliders reach the engine', p.alpha === 3.5 && p.ants === 7, JSON.stringify(p));
await page.click('#aco-step');
check('ACO: ant count used by algorithm', await page.evaluate(() => window.biopro.aco.engine.lastIteration.tours.length === 7));
// preset buttons + add node
await page.click('#aco-preset button[data-value="circle"]');
check('ACO: circle preset loads 12 nodes', await page.evaluate(() => window.biopro.aco.engine.n === 12));
await page.click('#aco-mode button[data-value="add"]');
const box = await page.locator('#aco-canvas').boundingBox();
await page.locator('#aco-canvas').click({ position: { x: box.width * 0.5, y: box.height * 0.5 } });
check('ACO: clicking canvas adds a node to the real graph', await page.evaluate(() => window.biopro.aco.engine.n === 13));
await page.click('#aco-mode button[data-value="inspect"]');
await page.evaluate(() => window.biopro.aco.step(5));
await page.evaluate(() => window.biopro.aco.select(0, 1));
check('ACO: edge inspector shows τ and history', (await txt('#aco-inspector')).includes('Pheromone τ'));
if (shots) await page.screenshot({ path: `${shots}/aco-desktop.png`, fullPage: false });

// ---------------- Antivirus lab
await page.click('#tab-av');
check('AV: tab switch shows antivirus view', await page.locator('#view-av').isVisible());
check('AV: iteration 0 at start', (await txt('#av-it')) === '0');
await page.locator('#av-speed').fill('5');
await page.click('#av-step');
await page.waitForTimeout(1500);
check('AV: Step runs one animated iteration', (await txt('#av-it')) === '1');
await page.click('#av-start');
await page.waitForFunction(() => window.biopro.av.state.complete === true, null, { timeout: 60000 });
check('AV: scan reaches completion', (await txt('#av-status')).startsWith('Complete'));
const m = await page.evaluate(() => window.biopro.av.engine.metrics());
const shown = { tp: await txt('#av-tp'), fp: await txt('#av-fp'), fn: await txt('#av-fn'), tn: await txt('#av-tn') };
check('AV: confusion matrix on screen matches engine', String(m.tp) === shown.tp && String(m.fp) === shown.fp && String(m.fn) === shown.fn && String(m.tn) === shown.tn, JSON.stringify(shown));
check('AV: no hardcoded "CPU savings" text', !(await page.content()).includes('CPU Overhead Savings'));
const malId = await page.evaluate(() => window.biopro.av.engine.files.find((f) => f.status === 'malicious')?.id ?? -1);
if (malId >= 0) {
  await page.evaluate((id) => window.biopro.av.select(id), malId);
  check('AV: inspector explains classification', (await txt('#av-inspector')).includes('Why this classification'));
}
const before = await page.evaluate(() => window.biopro.av.engine.files.map((f) => f.status).join());
await page.locator('#av-thr-m').fill('0.3');
await page.locator('#av-thr-s').fill('0.1');
await page.locator('#av-thr-s').dispatchEvent('input');
const after = await page.evaluate(() => window.biopro.av.engine.files.map((f) => f.status).join());
check('AV: threshold change re-classifies', before !== after);
await page.click('#av-inject');
check('AV: inject adds a malicious file', await page.evaluate(() => window.biopro.av.engine.files.at(-1).truth === 'malicious'));
await page.click('#av-compare');
await page.waitForFunction(() => document.querySelector('#av-compare-out').textContent.includes('Uniform'), null, { timeout: 20000 });
check('AV: scheduler comparison runs', true);
await page.click('#av-scenario button[data-value="normal"]');
check('AV: scenario switch resets', (await txt('#av-it')) === '0' && (await txt('#av-prec')) === 'undefined');
if (shots) { await page.click('#av-start'); await page.waitForTimeout(2500); await page.screenshot({ path: `${shots}/av-desktop.png` }); await page.click('#av-start'); }

// ---------------- Map lab
await page.click('#tab-map');
const dataOk = await page.evaluate(() => window.biopro.map.ready.then(() => true, () => false));
check('MAP: road data loads (or a readable error is shown)', dataOk || await page.locator('#map-msg').isVisible());
if (dataOk) {
  await page.waitForFunction(() => window.biopro.map.state.dij, null, { timeout: 20000 });
  check('MAP: Dijkstra reference computed', /\d/.test(await txt('#map-dij')));
  await page.click('#map-step');
  check('MAP: Step runs one ACO iteration', (await txt('#map-it')) === '1');
  await page.evaluate(() => window.biopro.map.step(25));
  const st = await page.evaluate(() => { const s = window.biopro.map.state; return { best: s.aco.best?.cost, dij: s.dij.cost, ok: s.aco.best && s.net.graph.isConnectedPath(s.aco.best.edges, s.origin.node, s.dest.node) }; });
  check('MAP: ACO best is a connected route', st.ok);
  check('MAP: ACO best ≥ Dijkstra optimum (same costs)', st.best >= st.dij - 1e-6, `${st.best} vs ${st.dij}`);
  const dijBefore = await page.evaluate(() => window.biopro.map.state.dij.edges.join());
  const name = await page.evaluate(() => { const s = window.biopro.map.state; const ids = s.dij.edges.map((e) => s.net.graph.edges[e].seg); ids.forEach((id) => s.net.setCongestion(id, 8)); return 'route'; });
  await page.click('#map-mult'); // no-op focus
  await page.evaluate(() => window.biopro.map.congestCorridor(/./, 1)); // triggers congestionChanged with the manual multipliers kept
  const dijAfter = await page.evaluate(() => window.biopro.map.state.dij.edges.join());
  check('MAP: congestion on the optimal route changes the Dijkstra route', dijBefore !== dijAfter, name);
  await page.click('#map-clear');
  await page.click('#map-objective button[data-value="distance"]');
  check('MAP: objective switch resets run', (await txt('#map-it')) === '0' && (await txt('#map-obj-label')).includes('distance'));
  await page.evaluate(() => window.biopro.map.step(10));
  check('MAP: verdict reported', (await txt('#map-verdict')).length > 20);
  if (shots) await page.screenshot({ path: `${shots}/map-desktop.png` });
}

// ---------------- Methodology + demo
await page.click('#tab-method');
check('METHOD: methodology visible', await page.locator('#method-body').isVisible());
await page.waitForTimeout(1500);
check('METHOD: MathJax rendered equations', (await page.locator('#method-body mjx-container').count()) > 3);
await page.click('#demo-open');
check('DEMO: guided demo opens at step 1', (await txt('#demo-n')).includes('STEP 1'));
check('DEMO: step 1 shows live engine probabilities', (await txt('#demo-live')).includes('P='));
await page.click('#demo-next');
await page.click('#demo-act');
check('DEMO: action runs the real engine', await page.evaluate(() => window.biopro.aco.engine.iteration === 1));
await page.click('#demo-close');

// ---------------- Responsive: no horizontal overflow
for (const [w, h] of [[1280, 800], [768, 1024], [390, 844]]) {
  await page.setViewportSize({ width: w, height: h });
  for (const tab of ['aco', 'av', 'map', 'method']) {
    await page.click(`#tab-${tab}`);
    await page.waitForTimeout(250);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`LAYOUT ${w}px ${tab}: no horizontal overflow`, overflow <= 1, `${overflow}px`);
    if (shots && w === 390) await page.screenshot({ path: `${shots}/${tab}-mobile.png`, fullPage: true });
  }
}

const relevantErrors = errors.filter((e) => !/fonts\.g|basemaps\.cartocdn|ERR_|net::/i.test(e));
check('No console errors (excluding blocked external fonts/tiles)', relevantErrors.length === 0, relevantErrors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
