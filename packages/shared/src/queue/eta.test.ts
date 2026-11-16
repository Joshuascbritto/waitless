import { describe, expect, it } from "vitest";
import { formatDisplayCode } from "./display-code.ts";
import {
  averageServiceMinutes,
  etaMinutes,
  etaRange,
  etaRangeForPosition,
  ewma,
  formatEtaRange,
} from "./eta.ts";

describe("ewma", () => {
  it("weighs recent values more (α = 0.3)", () => {
    // 10 → 0.3·20 + 0.7·10 = 13 → 0.3·10 + 0.7·13 = 12.1
    expect(ewma([10, 20, 10])).toBeCloseTo(12.1);
  });

  it("is undefined with no data", () => {
    expect(ewma([])).toBeUndefined();
  });
});

describe("averageServiceMinutes", () => {
  it("falls back to the queue default when nothing finished today", () => {
    expect(averageServiceMinutes([], 15)).toBe(15);
  });

  it("only uses the last 20 durations", () => {
    const old = Array.from({ length: 30 }, () => 100);
    const recent = Array.from({ length: 20 }, () => 10);

    expect(averageServiceMinutes([...old, ...recent], 15)).toBe(10);
  });
});

describe("etaMinutes", () => {
  it("divides the people ahead among active servers", () => {
    // 4 ahead, 2 servers, 10 min each → 20 min; nobody in service
    expect(
      etaMinutes({
        position: 5,
        activeServers: 2,
        avgServiceMinutes: 10,
        servingElapsedMinutes: [],
      }),
    ).toBe(20);
  });

  it("adds the remaining time of current services, averaged over servers", () => {
    // 1 ahead / 2 servers × 10 = 5, plus (10-4 + 10-12→0) / 2 = 3 → 8
    expect(
      etaMinutes({
        position: 2,
        activeServers: 2,
        avgServiceMinutes: 10,
        servingElapsedMinutes: [4, 12],
      }),
    ).toBe(8);
  });
});

describe("etaRange", () => {
  it.each([
    [17, { minMinutes: 15, maxMinutes: 20 }],
    [40, { minMinutes: 30, maxMinutes: 50 }],
    [2, { minMinutes: 0, maxMinutes: 5 }],
    [0, { minMinutes: 0, maxMinutes: 5 }],
  ])("%d min → %o", (minutes, expected) => {
    expect(etaRange(minutes)).toEqual(expected);
  });

  it("is null for the person who is next", () => {
    expect(
      etaRangeForPosition({
        position: 1,
        activeServers: 1,
        avgServiceMinutes: 15,
        servingElapsedMinutes: [5],
      }),
    ).toBeNull();
  });

  it("formats for humans", () => {
    expect(formatEtaRange({ minMinutes: 15, maxMinutes: 20 })).toBe("~15–20 min");
    expect(formatEtaRange({ minMinutes: 0, maxMinutes: 5 })).toBe("under 5 min");
  });
});

describe("formatDisplayCode", () => {
  it("pads to three digits", () => {
    expect(formatDisplayCode("A", 23)).toBe("A-023");
    expect(formatDisplayCode("B", 1)).toBe("B-001");
    expect(formatDisplayCode("A", 1234)).toBe("A-1234");
  });

  it("rejects numbers below 1", () => {
    expect(() => formatDisplayCode("A", 0)).toThrow(RangeError);
  });
});
