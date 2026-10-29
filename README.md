# Ant Colony Optimization — BTech Research Simulator

Interactive, scientifically honest ACO simulator for the BTech *Bio-Inspired Intelligent Algorithms* project
(Vidhi C403, Amrit C405, Rushi C429, Naishi C430).

| Lab | What it shows | Ground truth used for evaluation |
|---|---|---|
| **1 · ACO Lab** | Ant System on the Travelling Salesperson Problem (closed tour) | Exact optimum by Held–Karp (n ≤ 15) or polygon perimeter (circle) |
| **2 · Antivirus Lab** | ACO-inspired scheduling of deep scans on a synthetic file system | Synthetic labels known by construction → confusion matrix, precision, recall, F1 |
| **3 · Mumbai Routing Lab** | Source → destination ACO on a real OpenStreetMap road graph | Dijkstra on the identical graph and identical costs |
| **4 · Methodology** | Formulas, assumptions, data, metrics, limitations, references | — |

A **Guided demo** (top-right) walks a professor through all of it by driving the real engines, with live values.

---

## Run locally

Requires **Node.js 18+** (no dependencies to install).

```bash
npm run serve          # → http://localhost:5173
npm test               # 39 unit tests for the algorithm core (node:test)
```

Opening `index.html` directly from disk will not work, because browsers block `fetch()` of the road data from `file://` URLs. Use the server above. If you do open it from disk, the map lab shows a clear error message instead of a broken page.

Optional browser end-to-end test (needs Playwright with Chromium installed):

```bash
npm run serve &        # in one terminal
npm run test:e2e       # 52 checks: every control, metrics vs engine, layouts at 1280/768/390 px
```

## Deploy (Vercel, free)

It is a static site, so there is no build step:

1. Push this repository to GitHub (it is already connected to `biopro-nu.vercel.app`).
2. Vercel → Project → Settings → Build & Development: Framework preset **Other**, Build command **(empty)**, Output directory **`.`** (root).
3. Push to `main`, and Vercel redeploys automatically.

`.vercelignore` keeps tests, tools and the raw OSM export out of the deployment.

**No environment variables, API keys or paid services are needed.** The only runtime network request is
the CARTO "Dark Matter" basemap tiles (free for non-commercial use with attribution). If tiles fail to load (for example on offline college Wi-Fi),
the map shows a notice and the road graph, ants, pheromone and routing still work from the bundled data. Leaflet,
Chart.js and MathJax are vendored in `vendor/` (pinned versions, see `vendor/README.md`).

---

## Project structure

```
index.html                 app shell: 4 labs + methodology + guided demo
css/styles.css             design system (dark, restrained gold)
js/core/                   PURE algorithm code — no DOM, unit-tested in Node
  rng.js                   seeded PRNG (mulberry32) + roulette-wheel selection
  tsp-aco.js               Ant System for the TSP, nearest-neighbour, Held–Karp
  path-aco.js              ACO for source→destination paths (loop-erased walks)
  graph.js                 directed graph, Dijkstra (binary heap), Tarjan SCC, haversine
  roadgraph.js             Mumbai road model: objectives, congestion, landmarks
  antivirus.js             synthetic file system, risk model, ACO scheduler, metrics
js/ui/                     one controller per lab + charts + helpers + app shell
data/mumbai-roads.json     road graph built from OpenStreetMap (556 KB, 153 KB gzipped)
data/raw/                  the raw Overpass export used to build it (gzip)
tools/build-mumbai-graph.mjs   reproducible OSM → graph builder
tools/serve.mjs            zero-dependency dev server
tests/*.test.js            unit tests;  tests/e2e/smoke.mjs  browser test
vendor/                    Leaflet 1.9.4, Chart.js 4.4.1, MathJax 3.2.2
```

---

## Major bugs found in the original and fixed

| # | Problem in the original `index.html` | Fix |
|---|---|---|
| 1 | **The Mumbai "ACO" router was Dijkstra.** `solveACOShortestPath()` simply returned `solveDijkstraWeighted()`, so no ants or pheromone existed in Module 3. | Real path ACO (`js/core/path-aco.js`) with pheromone per road edge, compared to a separate Dijkstra run. |
| 2 | **"Traffic Adaptation Score: +94%"** was hardcoded. Afterwards it compared Dijkstra-on-current-costs with Dijkstra-on-stale-costs and presented the difference as an ACO improvement. | Removed. ACO and Dijkstra now use the same graph and same costs; the gap is reported honestly, even when ACO is worse. |
| 3 | **"CPU Overhead Savings: 38%"** was a static number. | Removed. Simulated cost units are computed from the run, plus a head-to-head comparison with a uniform scheduler on the same seed. |
| 4 | Antivirus detection **read the hidden ground truth** (`node.threat > 0.8`) directly. There was no evidence model, and the pheromone floor was 1.0. | Transparent risk model on noisy evidence, confidence-margin decision rules, MAX–MIN bounded pheromone. Classification never uses pheromone (verified by tests). |
| 5 | Mumbai edge weights were invented minute values on a 9-node graph (e.g. "Ghodbunder Connectivity" from the Airport to Thane). | 7,657-junction, 10,087-segment graph from OpenStreetMap, with distances from geometry and time from OSM `maxspeed` or documented class defaults. |
| 6 | The Mumbai page fired **11 requests to the public OSRM demo server** on every load (against its usage policy); the Esri tile attribution was incomplete. | Geometry is bundled; CARTO tiles carry full OSM/CARTO attribution and fail gracefully. |
| 7 | **Race condition**: Reset then Start within 40 ms (30 ms in antivirus) left two `setTimeout` loops running at double speed. | A single `Runner` per lab with a run token, so starting always cancels the previous loop. |
| 8 | Resizing the window re-ran `initScienceCanvas`. Node coordinates were raw pixels, so nodes drifted off-canvas; the antivirus graph was **rebuilt (scan state lost) on every tab switch and resize**. | Fixed logical world coordinates, a DPR-aware redraw on `ResizeObserver`, and state that persists across tabs. |
| 9 | TSP deposit was iteration-best only, although the page described Ant System `Σ Q/L_k`; τ was floored at 0.01 without explanation. | Implemented Ant System as described (all ants deposit), with standard `τ0 = m/C_nn` and log-space probabilities. |
| 10 | The convergence chart sampled every 2nd iteration and kept only 30 points; there was no average or iteration-best. | Full history (decimated for display) of best-so-far, iteration-best and average, plus the exact-optimum line. |
| 11 | β was labelled an "Exploration heuristic". | Corrected: β is greedy use of the distance heuristic. An exploration-vs-exploitation explainer was added. |
| 12 | No Step button; the antivirus ant-count slider only applied after reset; "Run ACO Logistics Router" only moved a marker along a precomputed path. | Start/Pause/Resume/Step/Reset everywhere; all sliders reach the live engine (verified by e2e). |
| 13 | `fa-radar` is not a Font Awesome Free icon, so the scan button was blank. Tailwind's Play CDN (not for production, prints a console warning) plus unpinned Chart.js/MathJax. | Inline SVG icons, a hand-written CSS design system, pinned vendored libraries. |
| 14 | Origin = destination left stale numbers on screen; canvases were blurry on high-DPI screens; there were no tests. | Handled explicitly; DPR-aware canvases; 39 unit tests and 52 browser checks. |

---

## How the algorithms work (short version)

**Ant System (TSP).** Ant *k* at node *i* picks unvisited *j* with
`P = τᵢⱼ^α · ηᵢⱼ^β / Σ τᵢₗ^α · ηᵢₗ^β`, with `η = 1/d`. After all *m* ants finish,
`τ ← (1−ρ)τ + Σₖ Q/Lₖ`. Large α or β means **exploitation**; small α, larger ρ and randomness mean **exploration**.
The TSP needs a closed tour through **every** node. That is a different objective from Lab 3's source→destination path.

**Antivirus pheromone model (ACO-inspired, not canonical ACO).** Ants choose files with
`P ∝ τ^α · η^β`, `η = triage prior × (1 − C(n))`. One deep scan produces noisy evidence (signature, behaviour,
attributes), and the risk estimate is `R̂ = 0.45·s̄ + 0.35·b̄ + 0.20·ā`. Deposit `Δτ = Q(ε + R̂)·C(n)`, `C(n) = n/(n+2)`,
then `τ ← clip((1−ρ)τ + ΣΔτ, τmin, τmax)`. Never-scanned files hold a neutral τ₀. The detector says *malicious* only if
`R̂ − z·σ/√n ≥ θm`, and *clean* if `R̂ + z·σ/√n < θs`. **Pheromone only decides where to look; it never classifies.**
Real malware does not emit pheromones, and this is labelled as an educational simulation throughout the UI.

Measured over 60 synthetic infected scenarios (default parameters): the median number of deep scans to the
**first confirmed threat** is **16 with ACO vs 32 with a uniform-random scheduler**. Coverage cost is about equal (133 vs 130
units); ACO adds about 19 units of monitoring re-scans on confirmed threats. The zero-day-like sample (no signature)
usually ends as *suspicious*, which is an honest false negative at default thresholds.

**Path ACO (Mumbai).** Ants walk the directed road graph with
`η = 1 / (max(0, c + h(j) − h(i)) + δ)`. This is the A*-style *reduced cost*: how much detour a road adds versus heading
straight for the destination. Half the junctions lie on one-way carriageways, so a strict "never revisit" rule traps ants.
Instead, revisits are allowed with a penalty and **loops are erased** on arrival (as in AntNet), so every deposited route
is a simple connected path. Ant System deposit `Q/L`. With defaults (α 1, β 1.5, ρ 0.1, 30 ants, 80 iterations), ACO's
gap to the Dijkstra optimum on five test routes was 0 / 0 / 0.8 / 19.5 / 0 % (time) and 7.9 / 2.5 / 1.2 / 19.4 / 0 % (distance).
**ACO is stochastic and not guaranteed to find the optimum**, and the UI says so whenever it doesn't.

## Mumbai map and routing data

* **Roads:** OpenStreetMap `highway = motorway | trunk | primary | secondary` (+ `_link`) inside
  18.89–19.27 °N, 72.77–73.03 °E, downloaded through the Overpass API (`overpass.openstreetmap.fr`, OSM snapshot
  2026-08-10) as four tiles merged by way id. That gives 8,097 ways, split at junctions. One-way rules come from OSM tags; only the
  largest strongly connected component is kept (7,657 of 8,410 junctions), so every origin can reach every destination.
  © OpenStreetMap contributors, **ODbL 1.0**. Rebuild with `npm run build:mumbai` (the output is byte-identical apart from the build timestamp).
* **Distance** comes from OSM geometry (haversine). **Estimated time** uses `maxspeed` where tagged (651 segments), otherwise assumed
  free-flow speeds: motorway 60, trunk 50, primary 40, secondary 30 km/h (links lower). This is **not live traffic**.
* **Congestion** is a **simulated** multiplier on travel time (per road or per OSM-named corridor such as *Rajiv Gandhi Sea Link* or
  *Western Express Highway*). It changes the time objective's edge costs, so Dijkstra is re-run and ACO adapts. Distance is unaffected.
* **Localities** are approximate centres snapped to the nearest junction, with the snap distance shown in the UI.
* **Coverage limits:** major roads only (no local streets, turn restrictions, signals or tolls).

## Automated tests — actual results

`npm test` (Node 22, node:test): **39 passed, 0 failed** (≈1 s). Covers: deterministic RNG; roulette selection;
valid TSP permutations and recomputed lengths; finite, non-negative τ under extreme parameters; exact `(1−ρ)` evaporation;
α and β influencing probabilities; Held–Karp exactness; ACO within 5 % of the optimum on a 10-city instance; reset and same-seed
reproducibility; Dijkstra = brute force; Dijkstra rejecting negative/NaN costs; simple connected ACO routes; ACO never
beating Dijkstra; congestion changing the optimal route; the bundled Mumbai graph (strong connectivity, landmark snapping,
objective-correct routes, congestion affecting time but not distance); the antivirus τ update rule, MAX–MIN bounds,
neutral τ₀, trail ordering malicious > grey > benign, pheromone never classifying, threshold re-classification,
confusion matrix and precision/recall/F1 recomputation, and undefined metrics reported as undefined.

`tests/e2e/smoke.mjs` (Playwright, Chromium): **52/52 checks passed**. These cover every Start/Pause/Resume/Step/Reset, sliders reaching
the engine, add-node changing the real graph, antivirus completion, on-screen confusion matrix equal to the engine,
threshold re-classification, malware injection, scheduler comparison, Mumbai Dijkstra/ACO/congestion/objective switch,
MathJax rendering, guided demo driving the engine, no horizontal overflow at 1280/768/390 px, and no console errors.
(The CI sandbox had no internet access, so the basemap-unavailable fallback was exercised as well.)

## Remaining limitations

* ACO results depend on parameters and seed; long cross-city routes can stay a few percent above the optimum.
* Road speeds are assumptions, not measurements; there is no real-time traffic (that would need a paid/keyed traffic API).
  The architecture accepts any cost function, so a traffic feed could be plugged into `RoadNetwork.costFn`.
* Antivirus features, weights and thresholds are illustrative, not learned from malware data.
* Browser timings are indicative only.

## Credits & licences

Code: MIT (see `LICENSE`). Map data © OpenStreetMap contributors (ODbL). Basemap © CARTO.
Leaflet (BSD-2), Chart.js (MIT), MathJax (Apache-2.0).
