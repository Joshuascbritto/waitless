/**
 * Estimated wait (SPEC §6.5). Deliberately simple and explainable:
 *
 * 1. Average service time = EWMA (α = 0.3) of today's last 20 service
 *    durations, so recent pace weighs more; falls back to the queue default.
 * 2. Time until my turn = people ahead ÷ active servers × average, plus the
 *    expected remaining time of the people being served right now.
 * 3. Shown as a 5-minute-rounded range (±20%), not a falsely precise number.
 */

export const EWMA_ALPHA = 0.3;
export const EWMA_WINDOW = 20;

/** Exponentially weighted moving average, oldest value first. Undefined for no data. */
export function ewma(values: readonly number[], alpha = EWMA_ALPHA): number | undefined {
  let average: number | undefined;
  for (const value of values) {
    average = average === undefined ? value : alpha * value + (1 - alpha) * average;
  }
  return average;
}

/**
 * Average minutes per customer. `recentMinutes` are today's completed service
 * durations, oldest first; only the last EWMA_WINDOW count.
 */
export function averageServiceMinutes(
  recentMinutes: readonly number[],
  defaultMinutes: number,
): number {
  return ewma(recentMinutes.slice(-EWMA_WINDOW)) ?? defaultMinutes;
}

export interface EtaInput {
  /** 1-based place among waiting tickets. */
  position: number;
  activeServers: number;
  avgServiceMinutes: number;
  /** Minutes each ticket currently being served has been in service. */
  servingElapsedMinutes: readonly number[];
}

/** Minutes until this ticket is likely called. */
export function etaMinutes({
  position,
  activeServers,
  avgServiceMinutes,
  servingElapsedMinutes,
}: EtaInput): number {
  const servers = Math.max(1, activeServers);
  const ahead = ((position - 1) / servers) * avgServiceMinutes;
  // Remaining time of current services, averaged over all servers (an idle server contributes 0).
  const remaining =
    servingElapsedMinutes.reduce(
      (sum, elapsed) => sum + Math.max(0, avgServiceMinutes - elapsed),
      0,
    ) / servers;
  return Math.ceil(ahead + remaining);
}

export interface EtaRange {
  minMinutes: number;
  maxMinutes: number;
}

const roundTo5 = (minutes: number) => Math.round(minutes / 5) * 5;

/** "~15–20 min": ±20%, each end rounded to 5 minutes, always at least 5 minutes wide. */
export function etaRange(minutes: number): EtaRange {
  const minMinutes = Math.max(0, roundTo5(minutes * 0.8));
  const maxMinutes = Math.max(minMinutes + 5, roundTo5(minutes * 1.2));
  return { minMinutes, maxMinutes };
}

/** Range for a waiting ticket, or null when it's next in line ("You're next"). */
export function etaRangeForPosition(input: EtaInput): EtaRange | null {
  return input.position <= 1 ? null : etaRange(etaMinutes(input));
}

/** "~15–20 min" */
export function formatEtaRange({ minMinutes, maxMinutes }: EtaRange): string {
  return minMinutes === 0 ? `under ${maxMinutes} min` : `~${minMinutes}–${maxMinutes} min`;
}
