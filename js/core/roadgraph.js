// Runtime model of the Mumbai road subset: expands the compact segment list built by
// tools/build-mumbai-graph.mjs into directed edges, and defines the cost objectives.

import { Graph, haversine } from './graph.js';

export const OBJECTIVES = Object.freeze({
  distance: { label: 'Shortest distance', unit: 'km' },
  time: { label: 'Lowest estimated travel time', unit: 'min' },
});

export class RoadNetwork {
  constructor(data) {
    if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.segments)) throw new Error('Road network file is malformed');
    this.meta = data.meta || {};
    this.names = data.names || [];
    this.nodes = data.nodes; // [lat, lng]
    this.segments = data.segments.map((s, i) => ({
      id: i, a: s[0], b: s[1], length: s[2], speed: s[3], cls: s[4], name: this.names[s[5]] || '', oneway: s[6] === 1,
      speedTagged: s[7] === 1, interior: s[8] || [],
    }));
    const edges = [];
    for (const s of this.segments) {
      if (!(s.length > 0) || !(s.speed > 0)) throw new Error(`Segment ${s.id} has invalid length/speed`);
      edges.push({ u: s.a, v: s.b, seg: s.id, rev: false });
      if (!s.oneway) edges.push({ u: s.b, v: s.a, seg: s.id, rev: true });
    }
    this.graph = new Graph(this.nodes.length, edges);
    this.congestion = new Float64Array(this.segments.length).fill(1);
    this.maxSpeedMs = Math.max(...this.segments.map((s) => s.speed)) / 3.6;
    // length-weighted harmonic mean free-flow speed (typical network speed)
    let L = 0; let T = 0;
    for (const s of this.segments) { L += s.length; T += s.length / s.speed; }
    this.refSpeedMs = L / T / 3.6;
  }

  get edges() { return this.graph.edges; }

  /** Free-flow travel time of a segment in seconds (length / speed). */
  freeFlowTime(segId) { const s = this.segments[segId]; return s.length / (s.speed / 3.6); }

  /** Simulated congested travel time = free-flow time × congestion multiplier. */
  edgeTime(ei) { const sid = this.graph.edges[ei].seg; return this.freeFlowTime(sid) * this.congestion[sid]; }
  edgeDistance(ei) { return this.segments[this.graph.edges[ei].seg].length; }

  costFn(objective) {
    return objective === 'time' ? (ei) => this.edgeTime(ei) : (ei) => this.edgeDistance(ei);
  }

  /**
   * Cost-to-go estimate used only for the ants' visibility η (not for correctness): straight-line
   * distance, or straight-line distance at the network's typical speed for the time objective.
   * It need not be admissible because ACO never prunes with it; Dijkstra does not use it at all.
   */
  heuristicFn(objective) {
    return (v, t) => {
      const [la, lo] = this.nodes[v];
      const [lb, lob] = this.nodes[t];
      const d = haversine(la, lo, lb, lob);
      return objective === 'time' ? d / this.refSpeedMs : d;
    };
  }

  /** Admissible lower bound on cost-to-go (straight-line distance, or that distance at the top speed). */
  lowerBoundFn(objective) {
    return (v, t) => {
      const [la, lo] = this.nodes[v];
      const [lb, lob] = this.nodes[t];
      const d = haversine(la, lo, lb, lob);
      return objective === 'time' ? d / this.maxSpeedMs : d;
    };
  }

  /** Both metrics for a route, regardless of which one was optimised. */
  routeMetrics(edgePath) {
    let distance = 0; let time = 0; let freeTime = 0;
    for (const ei of edgePath) {
      distance += this.edgeDistance(ei);
      time += this.edgeTime(ei);
      freeTime += this.freeFlowTime(this.graph.edges[ei].seg);
    }
    return { distance, time, freeTime, edges: edgePath.length };
  }

  /** Lat/lng polyline of a directed edge (endpoints + simplified interior). */
  edgeLatLngs(ei) {
    const e = this.graph.edges[ei];
    const s = this.segments[e.seg];
    const pts = [this.nodes[s.a]];
    for (let i = 0; i < s.interior.length; i += 2) pts.push([s.interior[i], s.interior[i + 1]]);
    pts.push(this.nodes[s.b]);
    return e.rev ? pts.reverse() : pts;
  }

  segmentLatLngs(sid) {
    const s = this.segments[sid];
    const pts = [this.nodes[s.a]];
    for (let i = 0; i < s.interior.length; i += 2) pts.push([s.interior[i], s.interior[i + 1]]);
    pts.push(this.nodes[s.b]);
    return pts;
  }

  nearestNode(lat, lng) {
    let best = -1; let bd = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const [a, b] = this.nodes[i];
      const d = (a - lat) ** 2 + ((b - lng) * Math.cos((lat * Math.PI) / 180)) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return { node: best, distance: haversine(lat, lng, this.nodes[best][0], this.nodes[best][1]) };
  }

  setCongestion(segId, mult) {
    const m = Number(mult);
    if (!(m >= 1 && m <= 20)) throw new Error('Congestion multiplier must be between 1 and 20');
    this.congestion[segId] = m;
  }

  clearCongestion() { this.congestion.fill(1); }

  /** Segment ids carrying a given road name (for corridor congestion). */
  segmentsByName(name) { return this.segments.filter((s) => s.name === name).map((s) => s.id); }

  /** Named corridors ranked by total length (for the congestion picker). */
  corridors(limit = 40) {
    const tot = new Map();
    for (const s of this.segments) if (s.name) tot.set(s.name, (tot.get(s.name) || 0) + s.length);
    return [...tot.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, len]) => ({ name, length: len }));
  }
}

/**
 * Well-known Mumbai localities (approximate locality centres, WGS84). Each is snapped to the
 * nearest node of the road graph at runtime; the snapping distance is shown to the user.
 */
export const LANDMARKS = [
  { name: 'CSMT / Fort', lat: 18.9398, lng: 72.8355 },
  { name: 'Colaba', lat: 18.9067, lng: 72.8147 },
  { name: 'Marine Drive / Churchgate', lat: 18.9322, lng: 72.8264 },
  { name: 'Mumbai Central', lat: 18.9696, lng: 72.8195 },
  { name: 'Byculla', lat: 18.9790, lng: 72.8330 },
  { name: 'Worli', lat: 19.0176, lng: 72.8172 },
  { name: 'Lower Parel', lat: 18.9953, lng: 72.8302 },
  { name: 'Dadar', lat: 19.0186, lng: 72.8424 },
  { name: 'Sion', lat: 19.0434, lng: 72.8626 },
  { name: 'Mahim', lat: 19.0390, lng: 72.8406 },
  { name: 'Bandra West', lat: 19.0596, lng: 72.8295 },
  { name: 'Bandra Kurla Complex (BKC)', lat: 19.0660, lng: 72.8650 },
  { name: 'Kurla', lat: 19.0726, lng: 72.8845 },
  { name: 'Chembur', lat: 19.0522, lng: 72.9005 },
  { name: 'Santacruz', lat: 19.0810, lng: 72.8410 },
  { name: 'Airport (T2, Sahar)', lat: 19.0974, lng: 72.8746 },
  { name: 'Andheri', lat: 19.1197, lng: 72.8468 },
  { name: 'Powai', lat: 19.1176, lng: 72.9060 },
  { name: 'Ghatkopar', lat: 19.0860, lng: 72.9081 },
  { name: 'Vikhroli', lat: 19.1110, lng: 72.9280 },
  { name: 'Goregaon', lat: 19.1663, lng: 72.8526 },
  { name: 'Malad', lat: 19.1874, lng: 72.8484 },
  { name: 'Borivali', lat: 19.2307, lng: 72.8567 },
  { name: 'Mulund', lat: 19.1726, lng: 72.9565 },
  { name: 'Thane', lat: 19.2183, lng: 72.9781 },
  { name: 'Vashi (Navi Mumbai)', lat: 19.0771, lng: 72.9986 },
];
