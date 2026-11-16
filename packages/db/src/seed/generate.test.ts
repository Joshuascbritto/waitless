import { describe, expect, it } from "vitest";
import { CANCEL_RATE, type HistoryInput, NO_SHOW_RATE, simulateHistory } from "./generate.ts";
import { normal, poisson, seededRandom } from "./random.ts";
import { addDays, isoWeekday, localDayOf, localTimeToInstant } from "./time.ts";

describe("time helpers", () => {
  it("convert local wall-clock time to UTC instants", () => {
    // Bahia is UTC-3 all year.
    expect(localTimeToInstant("2026-03-10", 9 * 60, "America/Bahia").toISOString()).toBe(
      "2026-03-10T12:00:00.000Z",
    );
    // New York, before and after the 2026-03-08 DST switch.
    expect(localTimeToInstant("2026-03-07", 9 * 60, "America/New_York").toISOString()).toBe(
      "2026-03-07T14:00:00.000Z",
    );
    expect(localTimeToInstant("2026-03-09", 9 * 60, "America/New_York").toISOString()).toBe(
      "2026-03-09T13:00:00.000Z",
    );
  });

  it("know local days and weekdays", () => {
    expect(localDayOf(new Date("2026-03-11T02:30:00Z"), "America/Bahia")).toBe("2026-03-10");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(isoWeekday("2026-03-09")).toBe(1); // Monday
    expect(isoWeekday("2026-03-15")).toBe(7); // Sunday
  });
});

describe("random helpers", () => {
  it("are deterministic for a seed", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("have roughly the right means", () => {
    const random = seededRandom(7);
    const n = 20_000;
    let poissonSum = 0;
    let normalSum = 0;
    for (let i = 0; i < n; i++) {
      poissonSum += poisson(random, 3);
      normalSum += normal(random, 20, 5);
    }
    expect(poissonSum / n).toBeCloseTo(3, 1);
    expect(normalSum / n).toBeCloseTo(20, 0);
  });
});

const NOW = new Date("2026-03-14T18:00:00Z"); // Saturday 15:00 in Bahia

function history(overrides: Partial<HistoryInput> = {}) {
  return simulateHistory({
    queue: { activeServers: 2, defaultServiceMinutes: 20, noShowAfterMinutes: 5 },
    profile: {
      hours: { 1: [9, 19], 2: [9, 19], 3: [9, 19], 4: [9, 19], 5: [9, 19], 6: [9, 17], 7: null },
      baseRate: 3,
      multiplier: (weekday, hour) => (weekday === 6 && hour < 12 ? 2.5 : 1),
    },
    timezone: "America/Bahia",
    today: "2026-03-14",
    days: 30,
    now: NOW,
    random: seededRandom(1),
    ...overrides,
  });
}

describe("simulateHistory", () => {
  const tickets = history();

  it("is deterministic for a seed", () => {
    expect(history()).toEqual(tickets);
  });

  it("only opens on business days and hours, in local time", () => {
    expect(tickets.length).toBeGreaterThan(500);
    for (const t of tickets) {
      expect(isoWeekday(t.day)).not.toBe(7);
      expect(localDayOf(t.joinedAt, "America/Bahia")).toBe(t.day);
      const localHour = (t.joinedAt.getUTCHours() + 24 - 3) % 24;
      expect(localHour).toBeGreaterThanOrEqual(9);
      expect(localHour).toBeLessThan(19);
    }
  });

  it("numbers each day 1..n without gaps, in join order", () => {
    const byDay = Map.groupBy(tickets, (t) => t.day);
    for (const dayTickets of byDay.values()) {
      expect(dayTickets.map((t) => t.number)).toEqual(dayTickets.map((_, i) => i + 1));
      const joins = dayTickets.map((t) => t.joinedAt.getTime());
      expect(joins).toEqual([...joins].sort((a, b) => a - b));
    }
  });

  it("keeps timestamps consistent with each status", () => {
    for (const t of tickets) {
      expect(t.finishedAt.getTime()).toBeLessThanOrEqual(NOW.getTime());
      if (t.status === "cancelled") {
        expect(t.calledAt).toBeNull();
      } else {
        expect(t.calledAt?.getTime()).toBeGreaterThanOrEqual(t.joinedAt.getTime());
      }
      if (t.status === "done") {
        expect(t.servingAt?.getTime()).toBeGreaterThan(t.calledAt?.getTime() ?? Infinity);
        expect(t.finishedAt.getTime()).toBeGreaterThan(t.servingAt?.getTime() ?? Infinity);
      } else {
        expect(t.servingAt).toBeNull();
      }
    }
  });

  it("abandons about 8% (cancelled) and 5% (no-show)", () => {
    const share = (status: string) =>
      tickets.filter((t) => t.status === status).length / tickets.length;
    expect(share("cancelled")).toBeGreaterThan(CANCEL_RATE - 0.03);
    expect(share("cancelled")).toBeLessThan(CANCEL_RATE + 0.03);
    expect(share("no_show")).toBeGreaterThan(NO_SHOW_RATE - 0.03);
    expect(share("no_show")).toBeLessThan(NO_SHOW_RATE + 0.03);
  });

  it("makes Saturday mornings busier than weekday mornings", () => {
    const morningJoins = (weekday: number) =>
      tickets.filter((t) => {
        const hour = (t.joinedAt.getUTCHours() + 21) % 24;
        return isoWeekday(t.day) === weekday && hour < 12;
      }).length;
    expect(morningJoins(6)).toBeGreaterThan(morningJoins(3) * 1.5);
  });

  it("leaves out what hasn't finished yet today", () => {
    const early = history({ now: new Date("2026-03-14T12:10:00Z") }); // Sat 09:10
    const today = early.filter((t) => t.day === "2026-03-14");
    for (const t of today) {
      expect(t.finishedAt.getTime()).toBeLessThanOrEqual(
        new Date("2026-03-14T12:10:00Z").getTime(),
      );
    }
  });
});
