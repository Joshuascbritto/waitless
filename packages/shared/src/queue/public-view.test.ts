import { describe, expect, it } from "vitest";
import { etaRangeForNewcomer, type QueueSnapshot, toPublicTicketView } from "./public-view.ts";

const now = new Date("2026-11-16T15:00:00Z");

// Snapshot rows deliberately carry extra private fields, as database rows would.
const row = (id: string, displayCode: string) => ({
  id,
  displayCode,
  customerName: `Name of ${id}`,
  customerEmail: `${id}@example.com`,
  publicToken: `secret-token-${id}`,
});

const snapshot: QueueSnapshot = {
  activeServers: 1,
  defaultServiceMinutes: 10,
  waiting: [row("w1", "A-004"), row("w2", "A-005"), row("w3", "A-006")],
  called: [row("c1", "A-003")],
  serving: [{ ...row("s1", "A-002"), servingAt: new Date(now.getTime() - 4 * 60_000) }],
  recentServiceMinutes: [],
  now,
};

describe("toPublicTicketView", () => {
  it("gives a waiting ticket its position and an ETA range", () => {
    const view = toPublicTicketView(
      { id: "w3", displayCode: "A-006", status: "waiting" },
      snapshot,
    );

    // 2 ahead × 10 min + (10 - 4) remaining = 26 → ~20–30
    expect(view).toEqual({
      displayCode: "A-006",
      status: "waiting",
      position: 3,
      etaRange: { minMinutes: 20, maxMinutes: 30 },
      nowServing: ["A-003", "A-002"],
    });
  });

  it("says 'next' (null ETA) at position 1", () => {
    const view = toPublicTicketView(
      { id: "w1", displayCode: "A-004", status: "waiting" },
      snapshot,
    );

    expect(view.position).toBe(1);
    expect(view.etaRange).toBeNull();
  });

  it("has no position or ETA once called", () => {
    const view = toPublicTicketView({ id: "c1", displayCode: "A-003", status: "called" }, snapshot);

    expect(view.position).toBeNull();
    expect(view.etaRange).toBeNull();
  });

  it("never contains other customers' names, emails or tokens", () => {
    const serialized = JSON.stringify(
      toPublicTicketView({ id: "w2", displayCode: "A-005", status: "waiting" }, snapshot),
    );

    expect(serialized).not.toMatch(/Name of|@example\.com|secret-token|"w1"|"c1"|"s1"/);
  });
});

describe("etaRangeForNewcomer", () => {
  it("estimates for whoever joins at the end of the line", () => {
    // position 4: 3 ahead × 10 + 6 remaining = 36 → ~30–45
    expect(etaRangeForNewcomer(snapshot)).toEqual({ minMinutes: 30, maxMinutes: 45 });
  });
});
