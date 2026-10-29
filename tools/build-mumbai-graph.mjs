#!/usr/bin/env node
// Builds the routing graph used by the Mumbai Routing Lab from a raw Overpass API export.
// Reproducible and dependency-free:   node tools/build-mumbai-graph.mjs <overpass.json> <out.json>
//
// Data: © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)
// Query used (see README):
//   [out:json][timeout:180];
//   way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link)$"]
//      (18.89,72.77,19.27,73.03);
//   out body geom qt;
// The query was run as four bounding-box tiles (split at 19.08 °N and 72.90 °E) and the ways merged by id.
//
// Steps
//  1. keep the major-road ways above; read node coordinates
//  2. split ways at junctions (nodes shared by ≥ 2 ways, or way endpoints) → road segments
//  3. segment length = Σ haversine between consecutive OSM nodes (metres)
//  4. direction from OSM tags: oneway=yes/-1, junction=roundabout, motorway implied oneway
//  5. free-flow speed = OSM maxspeed when tagged, otherwise an ASSUMED urban default per class
//  6. keep only the largest strongly connected component so every origin can reach every destination
//  7. Douglas–Peucker simplification of the drawn geometry (length is computed BEFORE simplifying)

import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { haversine, stronglyConnectedComponents } from '../js/core/graph.js';

const [, , inPath = 'data/raw/mumbai-overpass.json.gz', outPath = 'data/mumbai-roads.json'] = process.argv;

// Assumed free-flow speeds (km/h) where OSM has no maxspeed tag. Not real traffic data.
export const DEFAULT_SPEED = {
  motorway: 60, motorway_link: 35, trunk: 50, trunk_link: 30,
  primary: 40, primary_link: 30, secondary: 30, secondary_link: 25,
};
const CLASSES = Object.keys(DEFAULT_SPEED);

function parseMaxspeed(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh)?/i);
  if (!m) return null;
  let s = parseFloat(m[1]);
  if (m[2] && m[2].toLowerCase() === 'mph') s *= 1.609344;
  return s >= 5 && s <= 120 ? s : null;
}

function onewayDir(tags) {
  const ow = (tags.oneway || '').toLowerCase();
  if (ow === '-1' || ow === 'reverse') return -1;
  if (ow === 'yes' || ow === '1' || ow === 'true') return 1;
  if (ow === 'no' || ow === '0' || ow === 'false') return 0;
  if (tags.junction === 'roundabout' || tags.junction === 'circular') return 1;
  if (tags.highway === 'motorway') return 1; // OSM convention: motorway implies oneway
  return 0;
}

function perpDist(p, a, b) {
  // equirectangular projection in metres around a
  const k = Math.cos((a[0] * Math.PI) / 180);
  const ax = 0; const ay = 0;
  const bx = (b[1] - a[1]) * k * 111320; const by = (b[0] - a[0]) * 110540;
  const px = (p[1] - a[1]) * k * 111320; const py = (p[0] - a[0]) * 110540;
  const dx = bx - ax; const dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function simplify(pts, tol) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let md = 0; let mi = -1;
    for (let k = i + 1; k < j; k++) {
      const d = perpDist(pts[k], pts[i], pts[j]);
      if (d > md) { md = d; mi = k; }
    }
    if (md > tol && mi > 0) { keep[mi] = 1; stack.push([i, mi], [mi, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}

export function buildGraph(osm) {
  const coord = new Map();
  const ways = [];
  for (const el of osm.elements) {
    if (el.type === 'node') coord.set(el.id, [el.lat, el.lon]);
    else if (el.type === 'way' && el.tags && CLASSES.includes(el.tags.highway)) {
      ways.push(el);
      // "out body geom" form: coordinates are inline on the way
      if (Array.isArray(el.geometry)) {
        el.nodes.forEach((id, k) => { const g = el.geometry[k]; if (g && Number.isFinite(g.lat)) coord.set(id, [g.lat, g.lon]); });
      }
    }
  }
  // 2. junction detection
  const use = new Map();
  for (const w of ways) {
    w.nodes.forEach((id, k) => {
      const inc = k === 0 || k === w.nodes.length - 1 ? 2 : 1;
      use.set(id, (use.get(id) || 0) + inc);
    });
  }
  const isJunction = (id) => (use.get(id) || 0) >= 2;

  const nodeIndex = new Map();
  const nodes = [];
  const idx = (osmId) => {
    if (!nodeIndex.has(osmId)) { nodeIndex.set(osmId, nodes.length); nodes.push(coord.get(osmId)); }
    return nodeIndex.get(osmId);
  };

  const names = []; const nameIdx = new Map();
  const nameOf = (tags) => {
    const n = tags.name || tags['name:en'] || tags.ref || '';
    if (!nameIdx.has(n)) { nameIdx.set(n, names.length); names.push(n); }
    return nameIdx.get(n);
  };

  const segs = [];
  let missing = 0;
  for (const w of ways) {
    const ids = w.nodes.filter((id) => coord.has(id));
    if (ids.length < w.nodes.length) missing++;
    if (ids.length < 2) continue;
    const dir = onewayDir(w.tags);
    const cls = CLASSES.indexOf(w.tags.highway);
    const tagged = parseMaxspeed(w.tags.maxspeed);
    const speed = tagged ?? DEFAULT_SPEED[w.tags.highway];
    const nm = nameOf(w.tags);
    let start = 0;
    for (let k = 1; k < ids.length; k++) {
      if (k === ids.length - 1 || isJunction(ids[k])) {
        const part = ids.slice(start, k + 1);
        if (part[0] !== part[part.length - 1]) {
          const pts = part.map((id) => coord.get(id));
          let len = 0;
          for (let q = 1; q < pts.length; q++) len += haversine(pts[q - 1][0], pts[q - 1][1], pts[q][0], pts[q][1]);
          if (len > 0.5) {
            segs.push({ a: part[0], b: part[part.length - 1], pts, len, dir, cls, speed, speedTagged: tagged != null, nm, osmWay: w.id });
          }
        }
        start = k;
      }
    }
  }

  // directed adjacency for SCC
  for (const s of segs) { s.u = idx(s.a); s.v = idx(s.b); }
  const n = nodes.length;
  const arcs = [];
  for (const [si, s] of segs.entries()) {
    if (s.dir >= 0) arcs.push([s.u, s.v, si]);
    if (s.dir <= 0) arcs.push([s.v, s.u, si]);
  }
  const out = Array.from({ length: n }, () => []);
  arcs.forEach((a, k) => out[a[0]].push(k));
  const comp = stronglyConnectedComponents(n, out, (k) => arcs[k][1]);
  const size = new Map();
  for (const c of comp) size.set(c, (size.get(c) || 0) + 1);
  let bestComp = -1; let bestSize = 0;
  for (const [c, sz] of size) if (sz > bestSize) { bestSize = sz; bestComp = c; }

  // re-index nodes inside the largest SCC
  const keepNode = new Int32Array(n).fill(-1);
  const outNodes = [];
  for (let i = 0; i < n; i++) if (comp[i] === bestComp) { keepNode[i] = outNodes.length; outNodes.push(nodes[i].map((v) => +v.toFixed(5))); }
  const outSegs = [];
  for (const s of segs) {
    const u = keepNode[s.u]; const v = keepNode[s.v];
    if (u < 0 || v < 0) continue;
    // a two-way segment is kept; a one-way one only if its arc lies within the component (always true when both ends do)
    const geom = simplify(s.pts, 6).map((p) => [+p[0].toFixed(5), +p[1].toFixed(5)]);
    const flat = [];
    for (let q = 1; q < geom.length - 1; q++) flat.push(geom[q][0], geom[q][1]);
    outSegs.push([s.dir === -1 ? v : u, s.dir === -1 ? u : v, Math.round(s.len * 10) / 10, Math.round(s.speed * 10) / 10, s.cls, s.nm, s.dir === 0 ? 0 : 1, s.speedTagged ? 1 : 0, s.dir === -1 ? flat.length ? reversePairs(flat) : flat : flat]);
  }
  return {
    meta: {
      title: 'Mumbai major-road network subset',
      source: 'OpenStreetMap via Overpass API (overpass.openstreetmap.fr)',
      license: 'Data © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0',
      osmTimestamp: osm.osm3s?.timestamp_osm_base || null,
      builtAt: new Date().toISOString(),
      bbox: [18.89, 72.77, 19.27, 73.03],
      highwayClasses: CLASSES,
      defaultSpeedsKmh: DEFAULT_SPEED,
      speedNote: 'Free-flow speeds: OSM maxspeed where tagged, otherwise assumed per-class defaults. Not live traffic.',
      counts: { osmWays: ways.length, rawNodes: n, keptNodes: outNodes.length, keptSegments: outSegs.length, waysWithMissingNodes: missing },
      segmentFormat: '[u, v, length_m, speed_kmh, classIndex, nameIndex, oneway(0|1), speedTagged(0|1), interiorLatLngFlat]',
    },
    names,
    nodes: outNodes,
    segments: outSegs,
  };
}

function reversePairs(flat) {
  const out = [];
  for (let i = flat.length - 2; i >= 0; i -= 2) out.push(flat[i], flat[i + 1]);
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('build-mumbai-graph.mjs')) {
  const raw = readFileSync(inPath);
  const osm = JSON.parse((inPath.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'));
  const g = buildGraph(osm);
  writeFileSync(outPath, JSON.stringify(g));
  console.log(JSON.stringify(g.meta.counts), `→ ${outPath}`);
}
