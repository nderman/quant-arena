/**
 * Quant Farm — Seeded RNG
 *
 * A single, swappable random source so the entire simulation can be replayed
 * deterministically. Wires into referee (toxic flow, snipe cancel, competing
 * taker, maker lottery) and the dry-run pulse simulator.
 *
 * Usage:
 *   seedRng(42);  // reproducible run
 *   random();     // returns next [0,1)
 *
 * If never seeded (or seeded with 0), `random()` falls back to Math.random
 * — preserving non-determinism for production runs unless RNG_SEED is set.
 *
 * Algorithm: mulberry32 — small, fast, well-distributed for our use case
 * (fill rejections, slippage rolls). Not cryptographically secure (and
 * doesn't need to be).
 */

let _state = 0;
let _seeded = false;

/**
 * Seed the RNG. Pass a non-zero integer for reproducible output. Pass 0 to
 * disable seeding and fall back to Math.random.
 */
export function seedRng(seed: number): void {
  _state = seed >>> 0; // coerce to uint32
  _seeded = seed !== 0;
}

/** Returns the current seeded state (for debug logging / persistence). */
export function getRngState(): number {
  return _state;
}

/** Returns true if seedRng was called with a non-zero value. */
export function isSeeded(): boolean {
  return _seeded;
}

/**
 * Returns the next pseudo-random number in [0, 1).
 * Mulberry32 PRNG when seeded; Math.random otherwise.
 */
export function random(): number {
  if (!_seeded) return Math.random();
  // Mulberry32: https://gist.github.com/tommyettinger/46a3c2c1d1bdb43dc89e
  let t = (_state = (_state + 0x6D2B79F5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Reset to unseeded state — for tests that need to verify the fallback. */
export function _resetForTest(): void {
  _state = 0;
  _seeded = false;
}
