/**
 * Ticket lifecycle helpers used by background jobs: auto no-show (SPEC §12.5),
 * notification dedupe, one active ticket per device, data retention.
 */
import { eq } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.ts";
import { isUniqueViolation } from "./errors.ts";
import { deleteExpiredSessions, purgeAllCustomerEmails } from "./maintenance.ts";
import { recordNotified, wasNotified } from "./notifications.ts";
import {
  type Actor,
  callNext,
  createTicket,
  expireCall,
  findActiveTicketForDevice,
  pushBack,
  type QueueRow,
} from "./queue.ts";
import { queues, sessions, tickets, users } from "./schema.ts";
import { createTenantWithOwner } from "./tenants.ts";
import { createTestPool, startTestDatabase, type TestDatabase } from "./testing.ts";

const TZ = "America/Bahia";
const customer: Actor = { type: "customer", id: null };

let database: TestDatabase;
let pool: pg.Pool;
let db: Db;
let staffId: string;
let tenantId: string;
let otherTenantId: string;

async function newQueue(tenant: string, slug: string): Promise<QueueRow> {
  return db.withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(queues)
      .values({ tenantId: tenant, name: slug, slug })
      .returning();
    if (!row) throw new Error("queue insert failed");
    return row;
  });
}

beforeAll(async () => {
  database = await startTestDatabase();
  pool = createTestPool(database.appUrl, 10);
  db = createDb(pool);
  const [user] = await db.global
    .insert(users)
    .values({ email: "staff@example.com", name: "Staff", passwordHash: "x" })
    .returning();
  if (!user) throw new Error("user insert failed");
  staffId = user.id;
  tenantId = (await createTenantWithOwner(db, { name: "A", slug: "shop-a", timezone: TZ }, staffId))
    .id;
  otherTenantId = (
    await createTenantWithOwner(db, { name: "B", slug: "shop-b", timezone: TZ }, staffId)
  ).id;
});

afterAll(async () => {
  await pool?.end();
  await database?.stop();
});

describe("expireCall: auto no-show (SPEC §12.5)", () => {
  it("does nothing for a stale job after push-back and re-call; the fresh job works", async () => {
    const queue = await newQueue(tenantId, "no-show");
    await db.withTenant(tenantId, (tx) =>
      createTicket(tx, { queue, timezone: TZ, customerName: "Ana", source: "qr", actor: customer }),
    );
    const call = () =>
      db.withTenant(tenantId, async (tx) => {
        const ticket = await callNext(tx, { queueId: queue.id, staffId });
        if (!ticket?.calledAt) throw new Error("nothing called");
        return ticket;
      });

    const firstCall = await call();
    const firstCalledAtMs = firstCall.calledAt?.getTime() ?? 0;
    await db.withTenant(tenantId, (tx) =>
      pushBack(tx, { ticketId: firstCall.id, n: 2, actor: { type: "staff", id: staffId } }),
    );
    // Make sure the second call gets a different millisecond.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondCall = await call();
    const secondCalledAtMs = secondCall.calledAt?.getTime() ?? 0;
    expect(secondCalledAtMs).not.toBe(firstCalledAtMs);

    const stale = await db.withTenant(tenantId, (tx) =>
      expireCall(tx, { ticketId: firstCall.id, calledAtMs: firstCalledAtMs }),
    );
    expect(stale).toBeUndefined();
    const [stillCalled] = await db.withTenant(tenantId, (tx) =>
      tx.select().from(tickets).where(eq(tickets.id, firstCall.id)),
    );
    expect(stillCalled?.status).toBe("called");

    const fresh = await db.withTenant(tenantId, (tx) =>
      expireCall(tx, { ticketId: secondCall.id, calledAtMs: secondCalledAtMs }),
    );
    expect(fresh?.status).toBe("no_show");
  });

  it("does nothing once the customer showed up (serving)", async () => {
    const queue = await newQueue(tenantId, "showed-up");
    await db.withTenant(tenantId, (tx) =>
      createTicket(tx, { queue, timezone: TZ, customerName: "Bia", source: "qr", actor: customer }),
    );
    const called = await db.withTenant(tenantId, (tx) =>
      callNext(tx, { queueId: queue.id, staffId }),
    );
    if (!called?.calledAt) throw new Error("nothing called");
    await db.withTenant(tenantId, (tx) =>
      tx.update(tickets).set({ status: "serving" }).where(eq(tickets.id, called.id)),
    );

    const result = await db.withTenant(tenantId, (tx) =>
      expireCall(tx, { ticketId: called.id, calledAtMs: called.calledAt?.getTime() ?? 0 }),
    );

    expect(result).toBeUndefined();
  });
});

describe("recordNotified", () => {
  it("records a kind once; the second attempt is a no-op", async () => {
    const queue = await newQueue(tenantId, "notified");
    const ticket = await db.withTenant(tenantId, (tx) =>
      createTicket(tx, {
        queue,
        timezone: TZ,
        customerName: "Caio",
        source: "qr",
        actor: customer,
      }),
    );

    const first = await db.withTenant(tenantId, (tx) => recordNotified(tx, ticket, "almost"));
    const second = await db.withTenant(tenantId, (tx) => recordNotified(tx, ticket, "almost"));
    const otherKind = await db.withTenant(tenantId, (tx) => recordNotified(tx, ticket, "called:1"));

    expect([first, second, otherKind]).toEqual([true, false, true]);
    expect(await db.withTenant(tenantId, (tx) => wasNotified(tx, ticket.id, "almost"))).toBe(true);
  });
});

describe("one active ticket per device", () => {
  it("lets only one of two simultaneous joins from the same device through", async () => {
    const queue = await newQueue(tenantId, "device");
    const join = () =>
      db.withTenant(tenantId, (tx) =>
        createTicket(tx, {
          queue,
          timezone: TZ,
          customerName: "Davi",
          source: "qr",
          deviceId: "device-1",
          actor: customer,
        }),
      );

    const results = await Promise.allSettled([join(), join()]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" && isUniqueViolation(rejected.reason)).toBe(true);
    const active = await db.withTenant(tenantId, (tx) =>
      findActiveTicketForDevice(tx, { queueId: queue.id, deviceId: "device-1" }),
    );
    expect(active?.customerName).toBe("Davi");
  });
});

describe("data retention", () => {
  it("clears emails of tickets finished over 30 days ago, in every tenant", async () => {
    const now = new Date();
    const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
    const make = async (tenant: string, slug: string, finishedAt: Date | null) => {
      const queue = await newQueue(tenant, slug);
      const ticket = await db.withTenant(tenant, (tx) =>
        createTicket(tx, {
          queue,
          timezone: TZ,
          customerName: "Eva",
          customerEmail: `${slug}@example.com`,
          source: "qr",
          actor: customer,
        }),
      );
      if (finishedAt) {
        await db.withTenant(tenant, (tx) =>
          tx.update(tickets).set({ status: "done", finishedAt }).where(eq(tickets.id, ticket.id)),
        );
      }
      return { tenant, id: ticket.id };
    };
    const old = await make(tenantId, "old", daysAgo(31));
    const oldOther = await make(otherTenantId, "old-b", daysAgo(45));
    const recent = await make(tenantId, "recent", daysAgo(5));
    const active = await make(tenantId, "active", null);

    await purgeAllCustomerEmails(db, now);

    const emailOf = async ({ tenant, id }: { tenant: string; id: string }) =>
      (
        await db.withTenant(tenant, (tx) =>
          tx.select({ email: tickets.customerEmail }).from(tickets).where(eq(tickets.id, id)),
        )
      )[0]?.email;
    expect(await emailOf(old)).toBeNull();
    expect(await emailOf(oldOther)).toBeNull();
    expect(await emailOf(recent)).toBe("recent@example.com");
    expect(await emailOf(active)).toBe("active@example.com");
  });

  it("deletes expired sessions only", async () => {
    const now = new Date();
    await db.global.insert(sessions).values([
      { id: "expired", userId: staffId, expiresAt: new Date(now.getTime() - 1000) },
      { id: "valid", userId: staffId, expiresAt: new Date(now.getTime() + 60_000) },
    ]);

    expect(await deleteExpiredSessions(db, now)).toBe(1);
    const left = await db.global.select({ id: sessions.id }).from(sessions);
    expect(left.map((s) => s.id)).toEqual(["valid"]);
  });
});
