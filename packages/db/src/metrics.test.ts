/**
 * Metrics SQL against a real Postgres 18 with fixed fixtures (SPEC §10, §12).
 * The clock is pinned, so every number below is exact. Fixture times are UTC;
 * comments give the local time in the tenant's timezone.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, type Tx } from "./client.ts";
import { loadMetrics } from "./metrics.ts";
import { queues, ticketEvents, tickets, users } from "./schema.ts";
import { createTenantWithOwner } from "./tenants.ts";
import { createTestPool, startTestDatabase, type TestDatabase } from "./testing.ts";

const BAHIA = "America/Bahia"; // UTC-3 all year
const NEW_YORK = "America/New_York"; // DST starts 2026-03-08
// Wednesday 2026-03-11, 12:00 in Bahia.
const NOW = new Date("2026-03-11T15:00:00Z");

let database: TestDatabase;
let pool: pg.Pool;
let db: Db;
let tenantA: string;
let tenantB: string;
let tenantNy: string;
let haircut: string;
let beard: string;

interface Fixture {
  status: "waiting" | "done" | "cancelled" | "no_show" | "removed";
  joined: string;
  /** Every call, in order: the first one is what "wait" measures. */
  calls?: string[];
  serving?: string;
  finished?: string;
}

let numberSeq = 0;
async function insertTicket(tx: Tx, tenantId: string, queueId: string, f: Fixture) {
  numberSeq += 1;
  const lastCall = f.calls?.at(-1);
  const [ticket] = await tx
    .insert(tickets)
    .values({
      tenantId,
      queueId,
      publicToken: randomUUID(),
      number: numberSeq,
      displayCode: `A-${numberSeq}`,
      customerName: "Fixture",
      source: "qr",
      status: f.status,
      sortKey: String(new Date(f.joined).getTime()),
      joinedAt: new Date(f.joined),
      calledAt: lastCall ? new Date(lastCall) : null,
      servingAt: f.serving ? new Date(f.serving) : null,
      finishedAt: f.finished ? new Date(f.finished) : null,
    })
    .returning();
  if (!ticket) throw new Error("ticket insert failed");
  for (const at of f.calls ?? []) {
    await tx.insert(ticketEvents).values({
      tenantId,
      ticketId: ticket.id,
      queueId,
      type: "called",
      actorType: "staff",
      at: new Date(at),
    });
  }
}

async function insertQueue(tx: Tx, tenantId: string, slug: string): Promise<string> {
  const [row] = await tx.insert(queues).values({ tenantId, name: slug, slug }).returning();
  if (!row) throw new Error("queue insert failed");
  return row.id;
}

beforeAll(async () => {
  database = await startTestDatabase();
  pool = createTestPool(database.appUrl);
  db = createDb(pool);

  const [owner] = await db.global
    .insert(users)
    .values({ email: "owner@example.com", name: "Owner", passwordHash: "x" })
    .returning();
  if (!owner) throw new Error("user insert failed");

  const make = (slug: string, timezone: string) =>
    createTenantWithOwner(db, { name: slug, slug, timezone }, owner.id).then((t) => t.id);
  tenantA = await make("shop-a", BAHIA);
  tenantB = await make("shop-b", BAHIA);
  tenantNy = await make("shop-ny", NEW_YORK);

  await db.withTenant(tenantA, async (tx) => {
    haircut = await insertQueue(tx, tenantA, "haircut");
    beard = await insertQueue(tx, tenantA, "beard");

    // Tue 09:00. Called 09:10, pushed back, called again 09:30: wait is 600 s, not 1800.
    await insertTicket(tx, tenantA, haircut, {
      status: "done",
      joined: "2026-03-10T12:00:00Z",
      calls: ["2026-03-10T12:10:00Z", "2026-03-10T12:30:00Z"],
      serving: "2026-03-10T12:31:00Z",
      finished: "2026-03-10T12:51:00Z", // service 1200 s
    });
    // Tue 10:00, wait 1200 s, service 600 s.
    await insertTicket(tx, tenantA, haircut, {
      status: "done",
      joined: "2026-03-10T13:00:00Z",
      calls: ["2026-03-10T13:20:00Z"],
      serving: "2026-03-10T13:20:00Z",
      finished: "2026-03-10T13:30:00Z",
    });
    // Tue 23:30 local, already Wednesday in UTC: counts on Tuesday.
    await insertTicket(tx, tenantA, haircut, {
      status: "cancelled",
      joined: "2026-03-11T02:30:00Z",
      finished: "2026-03-11T02:40:00Z",
    });
    // Wed 10:00, wait 1800 s, then no-show.
    await insertTicket(tx, tenantA, haircut, {
      status: "no_show",
      joined: "2026-03-11T13:00:00Z",
      calls: ["2026-03-11T13:30:00Z"],
      finished: "2026-03-11T13:35:00Z",
    });
    // Wed 2026-03-04 23:59 local: one minute before the 7-day range starts.
    await insertTicket(tx, tenantA, haircut, { status: "done", joined: "2026-03-05T02:59:00Z" });
    // Thu 2026-03-05 00:00 local: first instant of the range. Removed: joins, never "final".
    await insertTicket(tx, tenantA, haircut, {
      status: "removed",
      joined: "2026-03-05T03:00:00Z",
      finished: "2026-03-05T03:05:00Z",
    });
    // After `now`: not counted.
    await insertTicket(tx, tenantA, haircut, { status: "waiting", joined: "2026-03-11T15:30:00Z" });
    // Wed 11:00 on the other queue, still waiting.
    await insertTicket(tx, tenantA, beard, { status: "waiting", joined: "2026-03-11T14:00:00Z" });
  });

  // Another tenant, same day: RLS keeps it out of tenant A's numbers.
  await db.withTenant(tenantB, async (tx) => {
    const queueId = await insertQueue(tx, tenantB, "grooming");
    await insertTicket(tx, tenantB, queueId, { status: "done", joined: "2026-03-11T13:00:00Z" });
  });

  // New York: the range starts on 2026-03-05 00:00 EST (05:00 UTC), before
  // the DST switch, even though `now` is already in EDT.
  await db.withTenant(tenantNy, async (tx) => {
    const queueId = await insertQueue(tx, tenantNy, "repairs");
    await insertTicket(tx, tenantNy, queueId, { status: "done", joined: "2026-03-05T04:59:00Z" });
    await insertTicket(tx, tenantNy, queueId, { status: "done", joined: "2026-03-05T05:00:00Z" });
  });
});

afterAll(async () => {
  await pool?.end();
  await database?.stop();
});

const metricsFor = (tenantId: string, timezone: string, queueId?: string) =>
  db.withTenant(tenantId, (tx) => loadMetrics(tx, { range: "7d", timezone, queueId, now: NOW }));

describe("loadMetrics", () => {
  it("computes the summary from first calls, final statuses and service times", async () => {
    const metrics = await metricsFor(tenantA, BAHIA);

    expect(metrics.from).toBe("2026-03-05");
    expect(metrics.to).toBe("2026-03-11");
    expect(metrics.summary).toEqual({
      joined: 6,
      served: 2,
      abandoned: 2,
      abandonmentRate: 0.5,
      avgWaitSeconds: 1200, // (600 + 1200 + 1800) / 3
      p90WaitSeconds: 1680, // percentile_cont(0.9) of [600, 1200, 1800]
      avgServiceSeconds: 900, // (1200 + 600) / 2
    });
  });

  it("zero-fills every local day and counts tickets on the day they joined", async () => {
    const { daily } = await metricsFor(tenantA, BAHIA);

    expect(daily.map((d) => d.day)).toEqual([
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
      "2026-03-11",
    ]);
    expect(daily.find((d) => d.day === "2026-03-05")).toEqual({
      day: "2026-03-05",
      joined: 1,
      served: 0,
    });
    // The 23:30 cancellation is Tuesday's, not Wednesday's.
    expect(daily.find((d) => d.day === "2026-03-10")).toEqual({
      day: "2026-03-10",
      joined: 3,
      served: 2,
    });
    expect(daily.find((d) => d.day === "2026-03-11")).toEqual({
      day: "2026-03-11",
      joined: 2,
      served: 0,
    });
  });

  it("buckets peak hours by local ISO weekday and hour", async () => {
    const { peakHours } = await metricsFor(tenantA, BAHIA);

    expect(peakHours).toEqual([
      { weekday: 2, hour: 9, joined: 1 },
      { weekday: 2, hour: 10, joined: 1 },
      { weekday: 2, hour: 23, joined: 1 },
      { weekday: 3, hour: 10, joined: 1 },
      { weekday: 3, hour: 11, joined: 1 },
      { weekday: 4, hour: 0, joined: 1 },
    ]);
  });

  it("narrows to one queue", async () => {
    const metrics = await metricsFor(tenantA, BAHIA, beard);

    expect(metrics.summary).toMatchObject({ joined: 1, served: 0, abandoned: 0 });
    expect(metrics.summary.abandonmentRate).toBeNull();
    expect(metrics.summary.avgWaitSeconds).toBeNull();
    expect(metrics.peakHours).toEqual([{ weekday: 3, hour: 11, joined: 1 }]);
  });

  it("never includes another tenant's tickets (RLS)", async () => {
    const metrics = await metricsFor(tenantB, BAHIA);
    expect(metrics.summary.joined).toBe(1);

    // Tenant A asking for tenant B's queue id sees nothing, not B's data.
    const [queueB] = await db.withTenant(tenantB, (tx) => tx.select().from(queues));
    const crossed = await metricsFor(tenantA, BAHIA, queueB?.id);
    expect(crossed.summary.joined).toBe(0);
  });

  it("starts the range at local midnight with the offset of that day (DST)", async () => {
    const metrics = await metricsFor(tenantNy, NEW_YORK);

    expect(metrics.from).toBe("2026-03-05");
    expect(metrics.summary.joined).toBe(1);
    expect(metrics.peakHours).toEqual([{ weekday: 4, hour: 0, joined: 1 }]);
  });

  it("returns 30 and 90 days when asked", async () => {
    const thirty = await db.withTenant(tenantA, (tx) =>
      loadMetrics(tx, { range: "30d", timezone: BAHIA, now: NOW }),
    );
    expect(thirty.daily).toHaveLength(30);
    expect(thirty.from).toBe("2026-02-10");
    // The 23:59 ticket from 2026-03-04 is inside a 30-day range.
    expect(thirty.summary.joined).toBe(7);
  });
});
