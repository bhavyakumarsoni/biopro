// Small DOM / formatting helpers shared by the labs.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const fmt = {
  n(v, d = 2) { return v == null || !Number.isFinite(v) ? '—' : Number(v).toFixed(d); },
  int(v) { return v == null || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString('en-IN'); },
  pct(v, d = 1) { return v == null || !Number.isFinite(v) ? 'undefined' : `${(v * 100).toFixed(d)}%`; },
  sci(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    if (v === 0) return '0';
    const a = Math.abs(v);
    return a >= 0.01 && a < 1e4 ? v.toPrecision(4) : v.toExponential(2);
  },
  km(m) { return m == null || !Number.isFinite(m) ? '—' : `${(m / 1000).toFixed(2)} km`; },
  min(s) { return s == null || !Number.isFinite(s) ? '—' : `${(s / 60).toFixed(1)} min`; },
  ms(v) { return v == null || !Number.isFinite(v) ? '—' : v < 1 ? `${(v * 1000).toFixed(0)} µs` : `${v.toFixed(1)} ms`; },
};

/** Bind a range input to a label and a callback; returns a setter. */
export function bindRange(input, output, onChange, format = (v) => v) {
  const update = (emit = true) => {
    const v = Number(input.value);
    if (output) output.textContent = format(v);
    if (emit) onChange(v);
  };
  input.addEventListener('input', () => update(true));
  update(false);
  return (v, emit = false) => { input.value = v; update(emit); };
}

/** Segmented control: buttons with data-value; aria-pressed reflects the selection. */
export function bindSeg(container, onChange) {
  const btns = $$('button', container);
  const set = (value, emit = true) => {
    btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === value)));
    if (emit) onChange(value);
  };
  btns.forEach((b) => b.addEventListener('click', () => set(b.dataset.value)));
  const cur = btns.find((b) => b.getAttribute('aria-pressed') === 'true');
  return { set, get: () => (btns.find((b) => b.getAttribute('aria-pressed') === 'true') || cur)?.dataset.value };
}

export function setPill(node, state, text) {
  node.className = `pill ${state}`;
  node.textContent = text;
}

/** Device-pixel-ratio aware canvas sizing. Returns {ctx, w, h} in CSS pixels. */
export function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/** Minimal sparkline for histories (no external chart dependency). */
export function drawSparkline(canvas, values, { color = '#ffd23f', fill = 'rgba(255,210,63,0.12)', marks = [] } = {}) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const vals = values.filter(Number.isFinite);
  if (vals.length < 2) {
    ctx.fillStyle = '#868697';
    ctx.font = '11px Inter, system-ui';
    ctx.fillText(vals.length ? 'Run more iterations to see history' : 'No history yet', 8, h / 2 + 4);
    return;
  }
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi - lo < 1e-12) { hi += 1; lo -= 1; }
  const pad = 6;
  const x = (i) => pad + (i / (values.length - 1)) * (w - 2 * pad);
  const y = (v) => h - pad - ((v - lo) / (hi - lo)) * (h - 2 * pad);
  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.lineTo(x(values.length - 1), h - pad);
  ctx.lineTo(x(0), h - pad);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  for (const m of marks) {
    ctx.fillStyle = m.color || '#2dd4bf';
    ctx.beginPath();
    ctx.arc(x(m.i), y(values[m.i]), 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#868697';
  ctx.font = '10px Fira Code, monospace';
  ctx.fillText(hi.toPrecision(3), pad, 10);
  ctx.fillText(lo.toPrecision(3), pad, h - 2);
}

/**
 * A run loop that guarantees only one active loop per lab (fixes the original
 * double-setTimeout race): every start() invalidates any previous loop token.
 */
export class Runner {
  constructor(tick) {
    this.tick = tick;
    this.token = 0;
    this.running = false;
    this.raf = 0;
  }
  start() {
    this.stop();
    this.running = true;
    const my = ++this.token;
    const loop = (t) => {
      if (!this.running || my !== this.token) return;
      const keep = this.tick(t);
      if (keep === false) { this.running = false; return; }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() {
    this.running = false;
    this.token++;
    cancelAnimationFrame(this.raf);
  }
}

export const ICONS = {
  play: '<path d="M7 4v16l13-8z"/>',
  pause: '<path d="M8 4v16M16 4v16"/>',
  step: '<path d="M5 4v16l10-8zM19 4v16"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  dice: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1"/><circle cx="15.5" cy="15.5" r="1"/><circle cx="12" cy="12" r="1"/>',
  flask: '<path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3"/><path d="M7 15h10"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  map: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
  book: '<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v5h1"/>',
  warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/>',
  swap: '<path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>',
  cursor: '<path d="M5 3l14 7-6 2-2 6z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  bug: '<path d="M9 7a3 3 0 0 1 6 0v1H9zM7 9h10v5a5 5 0 0 1-10 0z"/><path d="M12 12v7M3 13h4M17 13h4M4 7l3 2M20 7l-3 2M4 19l3-2M20 19l-3-2"/>',
  file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/>',
  slides: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  presenter: '<circle cx="12" cy="7" r="3"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/><path d="M17 4l3-2"/>',
  traffic: '<rect x="8" y="2" width="8" height="20" rx="3"/><circle cx="12" cy="7" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="17" r="1.5"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  next: '<path d="M9 6l6 6-6 6"/>',
  prev: '<path d="M15 6l-6 6 6 6"/>',
  log: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  scale: '<path d="M12 3v18M5 7h14M5 7l-3 7h6zM19 7l-3 7h6z"/>',
};

export function icon(name, cls = 'i') {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

/** Replace <i data-icon="name"></i> placeholders with inline SVG. */
export function hydrateIcons(root = document) {
  $$('i[data-icon]', root).forEach((n) => { n.outerHTML = icon(n.dataset.icon); });
}

export function typeset(root) {
  const mj = window.MathJax;
  if (mj && mj.typesetPromise) mj.typesetPromise(root ? [root] : undefined).catch(() => {});
}
