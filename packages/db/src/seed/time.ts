/**
 * Local calendar math for the seed, with only Intl (no date library). The
 * seed thinks in shop hours ("Saturday 09:00 in Bahia") and stores UTC.
 */

/** A local calendar day, "YYYY-MM-DD". */
export type LocalDay = string;

function parts(instant: Date, timeZone: string): Record<string, number> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return out;
}

/** Zone offset in ms at `instant` (local − UTC). Bahia: −3 h. */
function offsetMs(instant: Date, timeZone: string): number {
  const p = parts(instant, timeZone);
  const asUtc = Date.UTC(
    p.year ?? 0,
    (p.month ?? 1) - 1,
    p.day ?? 1,
    p.hour ?? 0,
    p.minute ?? 0,
    p.second ?? 0,
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The local calendar day of `instant` in `timeZone`. */
export function localDayOf(instant: Date, timeZone: string): LocalDay {
  const p = parts(instant, timeZone);
  const pad = (n: number | undefined, width = 2) => String(n ?? 0).padStart(width, "0");
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** `day` shifted by `delta` calendar days. */
export function addDays(day: LocalDay, delta: number): LocalDay {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + delta));
  return date.toISOString().slice(0, 10);
}

/** ISO weekday of a calendar day: 1 = Monday … 7 = Sunday. */
export function isoWeekday(day: LocalDay): number {
  const [y, m, d] = day.split("-").map(Number);
  const weekday = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/**
 * The instant when the wall clock in `timeZone` reads `day` + `minutes` past
 * midnight. Guess with the offset at the naive UTC time, then correct once
 * with the offset at the guess (handles DST changes between the two).
 */
export function localTimeToInstant(day: LocalDay, minutes: number, timeZone: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  const naive = Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1, 0, 0, 0) + Math.round(minutes * 60_000);
  const first = naive - offsetMs(new Date(naive), timeZone);
  const second = naive - offsetMs(new Date(first), timeZone);
  return new Date(second);
}
