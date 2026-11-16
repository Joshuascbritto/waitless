/**
 * Metrics contract (SPEC §10), shared by the API (validation, OpenAPI) and the
 * web app (types). Everything is computed in the tenant's timezone: a "day" is
 * a local calendar day and the heatmap is local weekday × local hour.
 */
import { z } from "zod";

export const METRICS_RANGES = ["7d", "30d", "90d"] as const;
export const MetricsRangeSchema = z.enum(METRICS_RANGES);
export type MetricsRange = z.infer<typeof MetricsRangeSchema>;

/** "30d" → 30. The range is today plus the previous N − 1 local days. */
export function rangeDays(range: MetricsRange): number {
  return Number.parseInt(range, 10);
}

export const MetricsQuerySchema = z.object({
  range: MetricsRangeSchema.default("7d"),
  /** Omitted: every queue of the tenant. */
  queueId: z.uuid().optional(),
});
export type MetricsQuery = z.infer<typeof MetricsQuerySchema>;

const count = z.number().int().nonnegative();
/** Null when there's nothing to average yet (no ticket called, none served...). */
const seconds = z.number().nonnegative().nullable();
const localDay = z.iso.date();

export const MetricsSummarySchema = z.object({
  /** Tickets that joined in the range. */
  joined: count,
  /** `done` tickets. */
  served: count,
  /** `cancelled` + `no_show`. */
  abandoned: count,
  /** abandoned / (served + abandoned): tickets in a final status, `removed` excluded. 0..1. */
  abandonmentRate: z.number().min(0).max(1).nullable(),
  /** First call − join, over tickets that were called. */
  avgWaitSeconds: seconds,
  p90WaitSeconds: seconds,
  /** finished − serving, over `done` tickets. */
  avgServiceSeconds: seconds,
});
export type MetricsSummary = z.infer<typeof MetricsSummarySchema>;

/** One local day. Tickets count on the day they joined. Every day of the range is present. */
export const DailyMetricsSchema = z.object({
  day: localDay,
  joined: count,
  served: count,
});
export type DailyMetrics = z.infer<typeof DailyMetricsSchema>;

/** Joins per local ISO weekday (1 = Monday … 7 = Sunday) and hour. Sparse: empty cells are left out. */
export const PeakHourCellSchema = z.object({
  weekday: z.number().int().min(1).max(7),
  hour: z.number().int().min(0).max(23),
  joined: count,
});
export type PeakHourCell = z.infer<typeof PeakHourCellSchema>;

export const MetricsSchema = z.object({
  range: MetricsRangeSchema,
  timezone: z.string(),
  /** First and last local day of the range (inclusive). */
  from: localDay,
  to: localDay,
  summary: MetricsSummarySchema,
  daily: z.array(DailyMetricsSchema),
  peakHours: z.array(PeakHourCellSchema),
});
export type Metrics = z.infer<typeof MetricsSchema>;

/** Monday-first labels for ISO weekdays 1..7. */
export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/**
 * Sparse cells → a dense 7 × 24 grid (`grid[weekday - 1][hour]`), plus the
 * busiest cell's count so the UI can scale colors. Duplicate cells add up.
 */
export function toHeatmapGrid(cells: readonly PeakHourCell[]): { grid: number[][]; max: number } {
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  let max = 0;
  for (const cell of cells) {
    const row = grid[cell.weekday - 1];
    if (!row) continue;
    row[cell.hour] = (row[cell.hour] ?? 0) + cell.joined;
    max = Math.max(max, row[cell.hour] ?? 0);
  }
  return { grid, max };
}

/**
 * Hours worth showing: from the earliest to the latest hour that has any
 * joins, so a shop open 9–19 doesn't get a mostly empty 24-column grid.
 * Falls back to 8–18 when there's no data yet.
 */
export function activeHourSpan(grid: readonly (readonly number[])[]): {
  first: number;
  last: number;
} {
  let first = 24;
  let last = -1;
  for (const row of grid) {
    row.forEach((value, hour) => {
      if (value > 0) {
        first = Math.min(first, hour);
        last = Math.max(last, hour);
      }
    });
  }
  return last < 0 ? { first: 8, last: 18 } : { first, last };
}

/** 754 → "13 min", 3900 → "1 h 5 min", null → "—". Whole minutes; under a minute shows "< 1 min". */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return "< 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
