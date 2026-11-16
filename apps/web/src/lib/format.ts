import { type EtaRange, formatEtaRange } from "@waitless/shared";

export function etaText(range: EtaRange | null): string {
  return range === null ? "You're next" : formatEtaRange(range);
}

/** "3 min ago" for board timestamps. */
export function minutesAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  return minutes === 0 ? "just now" : `${minutes} min ago`;
}

/** localStorage key for "my ticket in this queue", so reopening the link page finds it. */
export const ticketStorageKey = (tenantSlug: string, queueSlug: string) =>
  `waitless:ticket:${tenantSlug}:${queueSlug}`;

export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // private mode or blocked storage: the URL still works
  }
}

export function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Ignore: storage is a convenience, never required.
  }
}
