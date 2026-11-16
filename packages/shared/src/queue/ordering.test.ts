import { describe, expect, it } from "vitest";
import { compareKeys, incrementKey, midpoint, positionIn, pushBackSortKey } from "./ordering.ts";

describe("decimal sort keys", () => {
  it("computes exact midpoints", () => {
    expect(midpoint("1000", "2000")).toBe("1500");
    expect(midpoint("1000", "1001")).toBe("1000.5");
    expect(midpoint("1000.5", "1001")).toBe("1000.75");
  });

  it("stays exact after many nested push-backs, where floats would collide", () => {
    let low = "1794834206563";
    const high = "1794834206564";
    for (let i = 0; i < 60; i++) {
      const mid = midpoint(low, high);
      expect(compareKeys(low, mid)).toBe(-1);
      expect(compareKeys(mid, high)).toBe(-1);
      low = mid;
    }
  });

  it("increments by one", () => {
    expect(incrementKey("1794834206563")).toBe("1794834206564");
    expect(incrementKey("10.25")).toBe("11.25");
  });
});

describe("pushBackSortKey", () => {
  const waiting = ["100", "200", "300", "400"];

  it("lands between the nth and (n+1)th waiting tickets", () => {
    expect(pushBackSortKey(waiting, 2, "999")).toBe("250");
    expect(pushBackSortKey(waiting, 1, "999")).toBe("150");
  });

  it("goes to the end when fewer than n+1 are waiting", () => {
    expect(pushBackSortKey(waiting, 4, "999")).toBe("401");
    expect(pushBackSortKey(["100"], 2, "999")).toBe("101");
  });

  it("uses the fallback when nobody is waiting", () => {
    expect(pushBackSortKey([], 2, "999")).toBe("999");
  });

  it("rejects n < 1", () => {
    expect(() => pushBackSortKey(waiting, 0, "999")).toThrow(RangeError);
  });
});

describe("positionIn", () => {
  it("is 1-based, undefined when absent", () => {
    expect(positionIn(["a", "b", "c"], "a")).toBe(1);
    expect(positionIn(["a", "b", "c"], "c")).toBe(3);
    expect(positionIn(["a", "b", "c"], "z")).toBeUndefined();
  });
});
