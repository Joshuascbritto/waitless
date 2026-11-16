/**
 * Ordering among waiting tickets (SPEC §6.3).
 *
 * `sort_key` is a Postgres `numeric`, carried as a decimal string. New tickets
 * get the join time in epoch milliseconds; a push-back lands between two
 * existing keys. Arithmetic here is exact (BigInt on scaled integers), so
 * repeated push-backs never collide because of float rounding.
 */

interface Scaled {
  value: bigint;
  scale: number;
}

function parse(decimal: string): Scaled {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
  if (!match) {
    throw new TypeError(`not a decimal number: "${decimal}"`);
  }
  const [, sign = "", whole = "0", fraction = ""] = match;
  return { value: BigInt(`${sign}${whole}${fraction}`), scale: fraction.length };
}

function rescale(n: Scaled, scale: number): bigint {
  return n.value * 10n ** BigInt(scale - n.scale);
}

function format({ value, scale }: Scaled): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Exact midpoint of two decimals: one extra decimal digit is always enough. */
export function midpoint(a: string, b: string): string {
  const x = parse(a);
  const y = parse(b);
  const scale = Math.max(x.scale, y.scale);
  // (x + y) / 2 at scale+1 is (x + y) * 10 / 2 = (x + y) * 5, with no remainder.
  return format({ value: (rescale(x, scale) + rescale(y, scale)) * 5n, scale: scale + 1 });
}

/** a + 1 */
export function incrementKey(a: string): string {
  const x = parse(a);
  return format({ value: x.value + 10n ** BigInt(x.scale), scale: x.scale });
}

export function compareKeys(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  const scale = Math.max(x.scale, y.scale);
  const diff = rescale(x, scale) - rescale(y, scale);
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

/**
 * New sort key for a called ticket pushed back behind the next `n` people.
 *
 * @param waitingKeys sort keys of the tickets currently waiting, in queue order
 *   (the pushed ticket isn't among them: it's `called`).
 * @param n how many people go ahead of it (≥ 1).
 * @param fallbackKey used when nobody is waiting (e.g. the current time in ms).
 */
export function pushBackSortKey(
  waitingKeys: readonly string[],
  n: number,
  fallbackKey: string,
): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError("push back needs n ≥ 1");
  }
  const nth = waitingKeys[n - 1];
  const next = waitingKeys[n];
  if (nth !== undefined && next !== undefined) {
    return midpoint(nth, next);
  }
  // Fewer than n+1 waiting: go to the end of the line.
  const last = waitingKeys.at(-1);
  return last === undefined ? fallbackKey : incrementKey(last);
}

/** 1-based position of `ticketId` in an ordered waiting list, or undefined if absent. */
export function positionIn(
  orderedWaitingIds: readonly string[],
  ticketId: string,
): number | undefined {
  const index = orderedWaitingIds.indexOf(ticketId);
  return index === -1 ? undefined : index + 1;
}
