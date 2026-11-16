/**
 * Seeded randomness for the demo seed. Same seed, same history: tests can
 * assert on it, and a nightly reset produces a stable-looking demo.
 */

export type Random = () => number;

/** mulberry32: tiny, fast, good enough for fake data (not for anything secret). */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Uniform in [min, max). */
export function uniform(random: Random, min: number, max: number): number {
  return min + random() * (max - min);
}

/** Normal(mean, sd) via Box–Muller. */
export function normal(random: Random, mean: number, sd: number): number {
  const u = 1 - random(); // (0, 1]: log(0) would be -Infinity
  const v = random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Poisson(lambda) by Knuth's method: fine for the small rates of one shop hour. */
export function poisson(random: Random, lambda: number): number {
  if (lambda <= 0) return 0;
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= random();
  } while (p > limit);
  return k - 1;
}

export function pick<T>(random: Random, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("pick() from an empty list");
  return item;
}
