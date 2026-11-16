/**
 * Queue operations against a real Postgres 18, as waitless_app (RLS on).
 * Includes the mandatory concurrency tests: SPEC §12.1 and §12.3.
 */
import { InvalidTransitionError, NotFoundError } from "@waitless/shared";
import { eq } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.ts";
import {
  type Actor,
  allocateTicketNumber,
  callNext,
  createTicket,
  loadQueueState,
  pushBack,
  type QueueRow,
  transitionTicket,
} from "./queue.ts";
import { pushSubscriptions, queues, ticketEvents, tickets, users } from "./schema.ts";
import { createTenantWithOwner } from "./tenants.ts";
import { createTestPool, startTestDatabase, type TestDatabase } from "./testing.ts";

const TZ = "America/Bahia"; // UTC-3, no daylight saving
const customer: Actor = { type: "customer", id: null };

let database: TestDatabase;
let pool: pg.Pool;
let db: Db;
let tenantId: string;
let staffId: string;
let queue: QueueRow;

beforeAll(async () => {
  database = await startTestDatabase();
  // Big enough that 20–50 concurrent transactions really run in parallel.
  pool = createTestPool(database.appUrl, 30);
  db = createDb(pool);

  const [user] = await db.global
    .insert(users)
    .values({ email: "staff@example.com", name: "Staff", passwordHash: "x" })
    .returning();
  if (!user) throw new Error("user insert failed");
  staffId = user.id;
  tenantId = (
    await createTenantWithOwner(db, { name: "Shop", slug: "shop", timezone: TZ }, staffId)
  ).id;
});

afterAll(async () => {
  await pool?.end();
  await database?.stop();
});

let queueCounter = 0;
beforeEach(async () => {
  // A fresh queue per test keeps numbering and ordering independent.
  queueCounter += 1;
  queue = await db.withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .insert(queues)
      .values({ tenantId, name: `Queue ${queueCounter}`, slug: `queue-${queueCounter}` })
      .returning();
    if (!row) throw new Error("queue insert failed");
    return row;
  });
});

const join = (name: string) =>
  db.withTenant(tenantId, (tx) =>
    createTicket(tx, { queue, timezone: TZ, customerName: name, source: "qr", actor: customer }),
  );

const waitingNames = () =>
  db.withTenant(tenantId, async (tx) =>
    (await loadQueueState(tx, { queueId: queue.id, timezone: TZ })).waiting.map(
      (t) => t.customerName,
    ),
  );

describe("ticket numbering (SPEC §12.3)", () => {
  it("gives 50 parallel joins the numbers 1..50: no gaps, no duplicates", async () => {
    const created = await Promise.all(Array.from({ length: 50 }, (_, i) => join(`C${i}`)));

    const numbers = created.map((t) => t.number).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(new Set(created.map((t) => t.displayCode)).size).toBe(50);
  });

  it("restarts at midnight in the tenant's timezone, not at UTC midnight", async () => {
    const allocate = (iso: string) =>
      db.withTenant(tenantId, (tx) =>
        allocateTicketNumber(tx, { tenantId, queueId: queue.id, timezone: TZ, at: new Date(iso) }),
      );

    // 20:00 and 23:59 in Bahia on Nov 15 (the second is already Nov 16 in UTC).
    expect(await allocate("2026-11-15T23:00:00Z")).toBe(1);
    expect(await allocate("2026-11-16T02:59:00Z")).toBe(2);
    // 00:01 in Bahia on Nov 16: a new day, so back to 1.
    expect(await allocate("2026-11-16T03:01:00Z")).toBe(1);
    expect(await allocate("2026-11-16T12:00:00Z")).toBe(2);
  });

  it("formats display codes with the queue prefix", async () => {
    const ticket = await join("Ana");

    expect(ticket.displayCode).toBe("A-001");
  });
});

describe("callNext (SPEC §12.1)", () => {
  it("20 parallel calls vs 10 waiting: 10 distinct tickets, 10 empty, 0 errors", async () => {
    for (let i = 0; i < 10; i++) await join(`C${i}`);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        db.withTenant(tenantId, (tx) => callNext(tx, { queueId: queue.id, staffId })),
      ),
    );

    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    const values = results.map((r) => (r.status === "fulfilled" ? r.value : undefined));
    const called = values.filter((t) => t !== undefined);
    expect(called).toHaveLength(10);
    expect(new Set(called.map((t) => t.id)).size).toBe(10);
    expect(values.filter((t) => t === undefined)).toHaveLength(10);
    expect(await waitingNames()).toEqual([]);
  });

  it("calls in queue order and records who called", async () => {
    await join("First");
    await join("Second");

    const ticket = await db.withTenant(tenantId, (tx) =>
      callNext(tx, { queueId: queue.id, staffId }),
    );

    expect(ticket?.customerName).toBe("First");
    expect(ticket?.calledBy).toBe(staffId);
    expect(ticket?.calledAt).toBeInstanceOf(Date);
  });
});

describe("transitions", () => {
  const staff = (): Actor => ({ type: "staff", id: staffId });

  it("walks the happy path and logs one event per step", async () => {
    const { id } = await join("Ana");
    const act = (action: "call" | "start" | "finish") =>
      db.withTenant(tenantId, (tx) =>
        transitionTicket(tx, { ticketId: id, action, actor: staff() }),
      );

    await act("call");
    await act("start");
    const done = await act("finish");

    expect(done.status).toBe("done");
    expect(done.finishedAt).toBeInstanceOf(Date);
    const events = await db.withTenant(tenantId, (tx) =>
      tx.select().from(ticketEvents).where(eq(ticketEvents.ticketId, id)).orderBy(ticketEvents.id),
    );
    expect(events.map((e) => [e.type, e.actorType])).toEqual([
      ["joined", "customer"],
      ["called", "staff"],
      ["serving", "staff"],
      ["done", "staff"],
    ]);
  });

  it("rejects an illegal move with InvalidTransitionError and changes nothing", async () => {
    const { id } = await join("Ana");

    const attempt = db.withTenant(tenantId, (tx) =>
      transitionTicket(tx, { ticketId: id, action: "finish", actor: staff() }),
    );

    await expect(attempt).rejects.toBeInstanceOf(InvalidTransitionError);
    const [row] = await db.withTenant(tenantId, (tx) =>
      tx.select().from(tickets).where(eq(tickets.id, id)),
    );
    expect(row?.status).toBe("waiting");
  });

  it("lets exactly one of two concurrent identical actions win", async () => {
    const { id } = await join("Ana");

    const results = await Promise.allSettled(
      [1, 2].map(() =>
        db.withTenant(tenantId, (tx) =>
          transitionTicket(tx, { ticketId: id, action: "call", actor: staff() }),
        ),
      ),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      InvalidTransitionError,
    );
  });

  it("answers NotFoundError for an unknown ticket", async () => {
    const attempt = db.withTenant(tenantId, (tx) =>
      transitionTicket(tx, {
        ticketId: "01a1e46d-0000-7000-8000-000000000000",
        action: "call",
        actor: staff(),
      }),
    );

    await expect(attempt).rejects.toBeInstanceOf(NotFoundError);
  });

  it("deletes push subscriptions when the ticket reaches a final status", async () => {
    const { id } = await join("Ana");
    await db.withTenant(tenantId, (tx) =>
      tx.insert(pushSubscriptions).values({
        tenantId,
        ticketId: id,
        endpoint: "https://push.example/1",
        p256dh: "k",
        auth: "a",
      }),
    );

    await db.withTenant(tenantId, (tx) =>
      transitionTicket(tx, { ticketId: id, action: "cancel", actor: customer }),
    );

    const left = await db.withTenant(tenantId, (tx) =>
      tx.select().from(pushSubscriptions).where(eq(pushSubscriptions.ticketId, id)),
    );
    expect(left).toHaveLength(0);
  });
});

describe("pushBack (SPEC §6.3)", () => {
  it("puts a called ticket behind the next n waiting customers", async () => {
    for (const name of ["Ana", "Bia", "Caio", "Davi"]) await join(name);
    const called = await db.withTenant(tenantId, (tx) =>
      callNext(tx, { queueId: queue.id, staffId }),
    );
    if (!called) throw new Error("nothing called");

    const pushed = await db.withTenant(tenantId, (tx) =>
      pushBack(tx, { ticketId: called.id, n: 2, actor: { type: "staff", id: staffId } }),
    );

    expect(pushed.status).toBe("waiting");
    expect(pushed.pushCount).toBe(1);
    expect(await waitingNames()).toEqual(["Bia", "Caio", "Ana", "Davi"]);
  });

  it("goes to the end when fewer than n+1 are waiting", async () => {
    for (const name of ["Ana", "Bia"]) await join(name);
    const called = await db.withTenant(tenantId, (tx) =>
      callNext(tx, { queueId: queue.id, staffId }),
    );
    if (!called) throw new Error("nothing called");

    await db.withTenant(tenantId, (tx) =>
      pushBack(tx, { ticketId: called.id, n: 3, actor: { type: "staff", id: staffId } }),
    );

    expect(await waitingNames()).toEqual(["Bia", "Ana"]);
  });

  it("refuses to push back a ticket that isn't called", async () => {
    const { id } = await join("Ana");

    const attempt = db.withTenant(tenantId, (tx) =>
      pushBack(tx, { ticketId: id, n: 2, actor: { type: "staff", id: staffId } }),
    );

    await expect(attempt).rejects.toBeInstanceOf(InvalidTransitionError);
  });
});

describe("loadQueueState", () => {
  it("splits active tickets and reads today's service durations", async () => {
    const a = await join("Ana");
    await join("Bia");
    await db.withTenant(tenantId, async (tx) => {
      await transitionTicket(tx, { ticketId: a.id, action: "call", actor: customer });
      await transitionTicket(tx, { ticketId: a.id, action: "start", actor: customer });
      // Pretend Ana was served for 12 minutes.
      await tx
        .update(tickets)
        .set({ servingAt: new Date(Date.now() - 12 * 60_000) })
        .where(eq(tickets.id, a.id));
      await transitionTicket(tx, { ticketId: a.id, action: "finish", actor: customer });
    });

    const state = await db.withTenant(tenantId, (tx) =>
      loadQueueState(tx, { queueId: queue.id, timezone: TZ }),
    );

    expect(state.waiting.map((t) => t.customerName)).toEqual(["Bia"]);
    expect(state.called).toEqual([]);
    expect(state.serving).toEqual([]);
    expect(state.recentServiceMinutes).toHaveLength(1);
    expect(state.recentServiceMinutes[0]).toBeCloseTo(12, 0);
  });
});
