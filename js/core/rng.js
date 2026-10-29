// Deterministic pseudo-random number generation for reproducible demonstrations.
// mulberry32: small, fast 32-bit PRNG. Not cryptographic — used only so that a
// given seed always reproduces the same simulation run.

export function createRng(seed = 1) {
  let a = (Number(seed) >>> 0) || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    seed: Number(seed) >>> 0,
    next,
    /** uniform float in [min, max) */
    range(min, max) { return min + (max - min) * next(); },
    /** uniform integer in [0, n) */
    int(n) { return Math.floor(next() * n); },
    /** approximately normal(0,1) via Box–Muller */
    normal() {
      let u = 0;
      while (u === 0) u = next();
      const v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    pick(arr) { return arr[Math.floor(next() * arr.length)]; },
    shuffle(arr) {
      const a2 = arr.slice();
      for (let i = a2.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a2[i], a2[j]] = [a2[j], a2[i]];
      }
      return a2;
    },
  };
}

export function randomSeed() {
  return Math.floor(Math.random() * 1e9) + 1;
}

/**
 * Roulette-wheel selection. `weights` are non-negative finite numbers.
 * Returns an index, or -1 if there is nothing to choose from.
 * If every weight is zero (or numerically underflowed) it falls back to a
 * uniform choice so an ant is never stuck.
 */
export function rouletteSelect(weights, rng) {
  const n = weights.length;
  if (n === 0) return -1;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const w = weights[i];
    if (Number.isFinite(w) && w > 0) total += w;
  }
  if (!(total > 0) || !Number.isFinite(total)) return rng.int(n);
  let r = rng.next() * total;
  for (let i = 0; i < n; i++) {
    const w = weights[i];
    if (!(Number.isFinite(w) && w > 0)) continue;
    r -= w;
    if (r < 0) return i;
  }
  // floating-point remainder: return the last positive-weight index
  for (let i = n - 1; i >= 0; i--) if (weights[i] > 0) return i;
  return n - 1;
}
