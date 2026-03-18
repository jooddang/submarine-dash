// Deterministic seeded PRNG — shared between client and authority.
// Mulberry32: fast, deterministic, good distribution. Returns values in [0, 1).

export type SeededRNG = () => number;

export function createSeededRNG(seed: number): SeededRNG {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
