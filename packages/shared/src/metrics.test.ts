import { describe, expect, it } from "vitest";
import {
  activeHourSpan,
  formatDuration,
  MetricsQuerySchema,
  rangeDays,
  toHeatmapGrid,
} from "./metrics.ts";

describe("rangeDays", () => {
  it("parses the day count", () => {
    expect(rangeDays("7d")).toBe(7);
    expect(rangeDays("30d")).toBe(30);
    expect(rangeDays("90d")).toBe(90);
  });
});

describe("MetricsQuerySchema", () => {
  it("defaults to 7 days and rejects unknown ranges", () => {
    expect(MetricsQuerySchema.parse({})).toEqual({ range: "7d" });
    expect(MetricsQuerySchema.safeParse({ range: "365d" }).success).toBe(false);
    expect(MetricsQuerySchema.safeParse({ queueId: "nope" }).success).toBe(false);
  });
});

describe("toHeatmapGrid", () => {
  it("fills a 7 × 24 grid from sparse cells and tracks the max", () => {
    const { grid, max } = toHeatmapGrid([
      { weekday: 1, hour: 9, joined: 3 },
      { weekday: 7, hour: 23, joined: 5 },
      { weekday: 1, hour: 9, joined: 2 },
    ]);

    expect(grid).toHaveLength(7);
    expect(grid.every((row) => row.length === 24)).toBe(true);
    expect(grid[0]?.[9]).toBe(5);
    expect(grid[6]?.[23]).toBe(5);
    expect(grid[3]?.[12]).toBe(0);
    expect(max).toBe(5);
  });

  it("is all zeros with no data", () => {
    const { grid, max } = toHeatmapGrid([]);
    expect(max).toBe(0);
    expect(grid.flat().every((v) => v === 0)).toBe(true);
  });
});

describe("activeHourSpan", () => {
  it("spans the earliest to the latest hour with joins", () => {
    const { grid } = toHeatmapGrid([
      { weekday: 2, hour: 10, joined: 1 },
      { weekday: 6, hour: 8, joined: 1 },
      { weekday: 5, hour: 19, joined: 4 },
    ]);
    expect(activeHourSpan(grid)).toEqual({ first: 8, last: 19 });
  });

  it("falls back to business hours with no data", () => {
    expect(activeHourSpan(toHeatmapGrid([]).grid)).toEqual({ first: 8, last: 18 });
  });
});

describe("formatDuration", () => {
  it.each([
    [null, "—"],
    [20, "< 1 min"],
    [754, "13 min"],
    [3600, "1 h"],
    [3900, "1 h 5 min"],
  ])("%s s → %s", (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});
