// Presentation Deck: embedded Canva presentation (animations play in-page) + an interactive
// slide outline that summarises the deck and links each topic to the live lab.

import { $, escapeHtml, typeset } from './util.js';

export const CANVA_EMBED = 'https://www.canva.com/design/DAHXWrYVr0Y/xYfVG7uippbQh6M7_Zgiog/view?embed';
export const CANVA_VIEW = 'https://www.canva.com/design/DAHXWrYVr0Y/xYfVG7uippbQh6M7_Zgiog/view';

export const SLIDES = [
  {
    tag: 'Case file', title: 'The missing shortest path', sub: 'Ant Colony Optimization — a bio-inspired intelligent algorithm',
    points: [
      'How do thousands of ants with no map and no leader find short routes to food?',
      'We turn that behaviour into an algorithm and test it on three real problems.',
      'Every number in this website is computed live by the algorithms, not typed in.',
    ],
    takeaway: 'Key question: can simple agents that only leave and follow trails solve hard optimisation problems?',
    stats: [['3 labs', 'TSP · Antivirus · Mumbai roads'], ['1992', 'Ant System, M. Dorigo'], ['0', 'hardcoded results']],
  },
  {
    tag: 'Problem statement', title: 'Finding efficient paths', sub: 'Three problems where the number of options explodes',
    points: [
      'Antivirus optimisation — decide which files deserve expensive deep scans first.',
      'Network routing — send traffic across a changing, congested network.',
      'Logistics & supply chain — find short, cheap routes for delivery fleets.',
    ],
    takeaway: 'Brute force fails: a 15-city tour already has ~4.4 × 10¹⁰ distinct routes.',
    stats: [['(n−1)!/2', 'tours for n cities'], ['NP-hard', 'Travelling Salesperson'], ['7,657', 'junctions in our Mumbai graph']],
  },
  {
    tag: 'Biology', title: 'How real ants find efficient paths', sub: 'Foraging, pheromones and stigmergy',
    points: [
      'Explore — ants initially wander along many different routes.',
      'Deposit — they lay pheromone while travelling.',
      'Reinforce — shorter paths are completed faster, so they collect pheromone sooner.',
      'Evaporate — old trails fade, so outdated routes are forgotten.',
      'Converge — the colony gradually favours the efficient path.',
    ],
    takeaway: 'Stigmergy: ants coordinate indirectly by changing the environment, with no ant-to-ant talk or central control.',
    stats: [['Shorter path', '→ faster return'], ['Faster return', '→ more pheromone'], ['More pheromone', '→ more ants']],
  },
  {
    tag: 'Method', title: 'From biology to computer science', sub: 'Observe → Abstract → Model → Optimize',
    points: [
      'Observe — natural swarm intelligence: autonomous movement without maps or oversight.',
      'Abstract — strip away physical detail; keep only nodes, connections and costs.',
      'Model — turn trails into numbers τ on graph edges and choices into probabilities.',
      'Optimize — deploy software ants; evaporation lets bad choices fade out.',
    ],
    takeaway: 'Each lab is the same idea on a different graph: cities, files, or road junctions.',
    stats: [['Nodes', 'cities · files · junctions'], ['Edges', 'distances · scans · roads'], ['τ', 'shared memory on edges']],
  },
  {
    tag: 'Algorithm', title: 'How an artificial ant decides', sub: 'The state-transition rule', lab: 'aco',
    formula: '$$P_{ij}^k=\\frac{\\tau_{ij}^{\\alpha}\\,\\eta_{ij}^{\\beta}}{\\sum_{l\\in N_i^k}\\tau_{il}^{\\alpha}\\,\\eta_{il}^{\\beta}},\\qquad \\eta_{ij}=\\frac{1}{d_{ij}}$$',
    points: [
      'τ — pheromone on edge i→j (what the colony has learned).',
      'η — heuristic desirability, usually 1 / distance (what looks good locally).',
      'α and β weight the two; common Ant System settings are α ≈ 1, β ≈ 2–5 (Dorigo & Stützle, 2004).',
      'The choice is random but biased: good edges are likely, others can still be explored.',
    ],
    takeaway: 'Probabilistic choice is what keeps the colony exploring instead of always taking the nearest node.',
    stats: [['α', 'trail influence'], ['β', 'distance influence'], ['Σ P = 1', 'over unvisited nodes']],
  },
  {
    tag: 'Algorithm', title: 'Pheromone update & the exploration–exploitation balance', sub: 'Evaporate, then deposit', lab: 'aco',
    formula: '$$\\tau_{ij}\\leftarrow(1-\\rho)\\,\\tau_{ij}+\\sum_{k=1}^{m}\\frac{Q}{L_k}$$',
    points: [
      'Evaporation (ρ) shrinks every trail, letting the search move away from poor choices.',
      'Each ant adds Q / L to the edges it used, so shorter tours deposit more.',
      'Exploitation (high α, high β) uses what is known; exploration (low α, higher ρ) tries new routes.',
      'Too much exploitation → stagnation in a local trap; too much exploration → wasted computation.',
    ],
    takeaway: 'Try α = 5, β = 0 versus α = 0, β = 5 in the ACO Lab and watch convergence change.',
    stats: [['ρ', 'evaporation rate'], ['Q / L', 'deposit per ant'], ['Held–Karp', 'exact check for n ≤ 15']],
  },
  {
    tag: 'Variants', title: 'Major ACO variants', sub: 'Same idea, different update rules',
    points: [
      'Ant System (AS) — every ant deposits; the original model (used in our TSP lab).',
      'Elitist AS — the best-so-far tour gets a bonus deposit; faster, riskier.',
      'MAX–MIN AS — pheromone kept within [τmin, τmax] (used in our antivirus lab).',
      'Ant Colony System — local pheromone reduction plus a global-best update.',
      'Rank-based AS — only top-ranked ants deposit, weighted by rank.',
    ],
    takeaway: 'Bounds and elitism trade convergence speed against the risk of getting stuck.',
    stats: [['1992', 'Ant System'], ['1997', 'Ant Colony System'], ['2000', 'MAX–MIN Ant System']],
  },
  {
    tag: 'Application 1', title: 'Antivirus investigation prioritisation', sub: 'ACO decides where to look, evidence decides the verdict', lab: 'av',
    points: [
      'Each file has signature, behaviour and attribute evidence from noisy simulated scans.',
      'Risk R̂ = 0.45·sig + 0.35·beh + 0.20·attr; verdicts use thresholds with a confidence margin.',
      'Ants deposit more pheromone on risky files, so they are re-checked sooner.',
      'Pheromone never classifies a file — it only changes investigation priority.',
    ],
    takeaway: 'Educational simulation on synthetic files: it shows the scheduling idea, not a production antivirus.',
    stats: [['16 vs 32', 'median scans to first threat (ACO vs random, 60 runs)'], ['≈ equal', 'coverage cost'], ['MAX–MIN', 'bounded trails']],
  },
  {
    tag: 'Application 2', title: 'Mumbai routing & logistics', sub: 'Real OpenStreetMap roads, ACO vs Dijkstra', lab: 'map',
    points: [
      'Major roads of Mumbai from OpenStreetMap: 7,657 junctions, 10,087 road segments.',
      'Objective: shortest distance or lowest estimated travel time (free-flow speeds).',
      'Simulated congestion (e.g. on the Sea Link) changes costs; ants adapt through evaporation.',
      'Dijkstra on the same graph and costs gives the exact optimum to compare against.',
    ],
    takeaway: 'ACO often matches the optimum, but it is stochastic: the lab reports the gap honestly when it does not.',
    stats: [['7,657', 'OSM junctions'], ['2', 'objectives: km / min'], ['Exact', 'Dijkstra reference']],
  },
  {
    tag: 'Conclusion', title: 'Comparison & future possibilities', sub: 'Where swarm intelligence fits',
    points: [
      'GA (evolution), PSO (bird flocking) and slime-mould algorithms solve similar problems — no algorithm is best everywhere.',
      'ACO shines on graph problems: routing, scheduling, assignment, feature selection.',
      'Future: adaptive cybersecurity monitoring, robot and drone swarms, smart-city logistics with live traffic.',
      'Real deployment needs validation, reliable data and safety constraints.',
    ],
    takeaway: 'Simple local rules + shared memory + forgetting = collective problem solving.',
    stats: [['GA · PSO · SMA', 'related bio-inspired methods'], ['Graphs', 'ACO’s natural home'], ['Validate', 'before deploying']],
  },
];

export function initDeck({ goTo }) {
  const frame = $('#deck-frame');
  const frameWrap = $('#deck-frame-wrap');
  let frameLoaded = false;
  let idx = 0;
  let dir = 1;

  function loadFrame() {
    if (frameLoaded) return;
    frameLoaded = true;
    if (!navigator.onLine) {
      $('#deck-frame-msg').hidden = false;
      $('#deck-frame-msg').innerHTML = 'You appear to be offline, so the Canva deck cannot load. Use the <a href="ANT%20COLONY%20OPTIMIZATION.pdf" target="_blank" rel="noopener">PDF backup</a>.';
      return;
    }
    frame.addEventListener('load', () => { $('#deck-frame-msg').hidden = true; }, { once: true });
    frame.src = CANVA_EMBED;
  }

  $('#deck-full').addEventListener('click', () => frameWrap.requestFullscreen?.().catch(() => {}));
  $('#outline-full').addEventListener('click', toggleOutlineFullscreen);

  const index = $('#outline-index');
  index.innerHTML = SLIDES.map((s, i) => `<option value="${i}">${i + 1}. ${escapeHtml(s.title)}</option>`).join('');
  index.addEventListener('change', () => show(Number(index.value)));
  $('#outline-prev').addEventListener('click', () => show(idx - 1));
  $('#outline-next').addEventListener('click', () => show(idx + 1));

  function toggleOutlineFullscreen() {
    const el = $('#outline');
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.().catch(() => {});
  }

  function show(i) {
    const next = Math.max(0, Math.min(SLIDES.length - 1, i));
    dir = next >= idx ? 1 : -1;
    idx = next;
    const s = SLIDES[idx];
    const body = $('#outline-body');
    body.classList.remove('enter-l', 'enter-r');
    void body.offsetWidth; // restart the CSS transition
    body.classList.add(dir > 0 ? 'enter-r' : 'enter-l');
    body.innerHTML = `
      <div class="slide-main">
        <div class="slide-top"><span class="chip gold">${escapeHtml(s.tag)}</span><span class="slide-n">Slide ${idx + 1} of ${SLIDES.length}</span></div>
        <h3 class="slide-title">${escapeHtml(s.title)}</h3>
        <p class="slide-sub">${escapeHtml(s.sub)}</p>
        ${s.formula ? `<div class="eq slide-eq">${s.formula}</div>` : ''}
        <ul class="slide-points">${s.points.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
        <div class="slide-take"><b>Takeaway:</b> ${escapeHtml(s.takeaway)}</div>
        ${s.lab ? `<button class="btn sm" data-lab="${s.lab}">Open this in the ${{ aco: 'ACO', av: 'Antivirus', map: 'Mumbai Routing' }[s.lab]} Lab →</button>` : ''}
      </div>
      <div class="slide-stats">${s.stats.map(([v, k]) => `<div class="slide-stat"><div class="v">${escapeHtml(v)}</div><div class="k">${escapeHtml(k)}</div></div>`).join('')}</div>`;
    body.querySelector('[data-lab]')?.addEventListener('click', (e) => goTo(e.currentTarget.dataset.lab));
    index.value = String(idx);
    $('#outline-prev').disabled = idx === 0;
    $('#outline-next').disabled = idx === SLIDES.length - 1;
    $('#outline-progress').style.width = `${((idx + 1) / SLIDES.length) * 100}%`;
    $('#outline-count').textContent = `${idx + 1}/${SLIDES.length}`;
    typeset(body);
  }

  let active = false;
  document.addEventListener('keydown', (e) => {
    if (!active) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); show(idx + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); show(idx - 1); }
    else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleOutlineFullscreen(); }
  });

  show(0);
  return {
    onShow() { active = true; loadFrame(); },
    onHide() { active = false; },
    show,
    get index() { return idx; },
  };
}
