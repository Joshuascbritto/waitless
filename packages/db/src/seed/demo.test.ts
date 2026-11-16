/** The demo seed against a real Postgres 18, as waitless_app (RLS on). */

import { eq, inArray } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../client.ts";
import { loadMetrics } from "../metrics.ts";
import { createTicket, loadQueueState } from "../queue.ts";
import { memberships, queues, tenants, tickets, users } from "../schema.ts";
import { createTestPool, startTestDatabase, type TestDatabase } from "../testing.ts";
import { DEMO_TENANTS, DEMO_USERS, DemoAlreadySeededError, seedDemo } from "./demo.ts";
import { localDayOf } from "./time.ts";

const NOW = new Date("2026-03-14T18:00:00Z"); // Saturday 15:00 in Bahia

let database: TestDatabase;
let pool: pg.Pool;
let db: Db;

beforeAll(async () => {
  database = await startTestDatabase();
  pool = createTestPool(database.appUrl);
  db = createDb(pool);
});

afterAll(async () => {
  await pool?.end();
  await database?.stop();
});

const tenantBySlug = async (slug: string) => {
  const [tenant] = await db.global.select().from(tenants).where(eq(tenants.slug, slug));
  if (!tenant) throw new Error(`tenant ${slug} missing`);
  return tenant;
};

describe("seedDemo", () => {
  it("creates the demo tenants, users, history and live tickets", async () => {
    const result = await seedDemo(db, { passwordHash: "hash", now: NOW });

    expect(result.tenants).toBe(2);
    expect(result.tickets).toBeGreaterThan(1000);

    const demoUsers = await db.global
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.email, [DEMO_USERS.owner.email, DEMO_USERS.staff.email]));
    expect(demoUsers).toHaveLength(2);

    const barbearia = await tenantBySlug("barbearia-demo");
    const roles = await db.withTenant(barbearia.id, (tx) =>
      tx.select({ role: memberships.role }).from(memberships),
    );
    expect(roles.map((r) => r.role).sort()).toEqual(["owner", "staff"]);

    // The board isn't empty, and the history makes the metrics page look real.
    await db.withTenant(barbearia.id, async (tx) => {
      const [haircut] = await tx.select().from(queues).where(eq(queues.slug, "haircut"));
      if (!haircut) throw new Error("haircut queue missing");
      const state = await loadQueueState(tx, { queueId: haircut.id, timezone: barbearia.timezone });
      expect(state.waiting).toHaveLength(4);
      expect(state.serving).toHaveLength(2);

      const metrics = await loadMetrics(tx, {
        range: "30d",
        timezone: barbearia.timezone,
        now: NOW,
      });
      expect(metrics.summary.served).toBeGreaterThan(500);
      expect(metrics.summary.avgWaitSeconds).toBeGreaterThan(0);
      expect(metrics.summary.abandonmentRate).toBeGreaterThan(0.05);
      expect(metrics.summary.abandonmentRate).toBeLessThan(0.25);
      expect(metrics.daily.filter((d) => d.joined > 0).length).toBeGreaterThan(20);
    });
  });

  it("continues today's numbering for the next real join", async () => {
    const barbearia = await tenantBySlug("barbearia-demo");
    await db.withTenant(barbearia.id, async (tx) => {
      const [beard] = await tx.select().from(queues).where(eq(queues.slug, "beard"));
      if (!beard) throw new Error("beard queue missing");
      const all = await tx
        .select({ number: tickets.number, joinedAt: tickets.joinedAt })
        .from(tickets)
        .where(eq(tickets.queueId, beard.id));
      const todayMax = Math.max(
        ...all
          .filter((t) => localDayOf(t.joinedAt, barbearia.timezone) === "2026-03-14")
          .map((t) => t.number),
      );
      const ticket = await createTicket(tx, {
        queue: beard,
        timezone: barbearia.timezone,
        customerName: "Real customer",
        source: "qr",
        actor: { type: "customer", id: null },
        at: NOW,
      });
      expect(todayMax).toBeGreaterThan(1);
      expect(ticket.number).toBe(todayMax + 1);
    });
  });

  it("refuses to seed twice, and --reset-demo replaces the data", async () => {
    await expect(seedDemo(db, { passwordHash: "hash", now: NOW })).rejects.toBeInstanceOf(
      DemoAlreadySeededError,
    );

    const before = await tenantBySlug("barbearia-demo");
    const result = await seedDemo(db, { passwordHash: "hash2", now: NOW, reset: true });
    const after = await tenantBySlug("barbearia-demo");

    expect(after.id).not.toBe(before.id);
    expect(result.tenants).toBe(DEMO_TENANTS.length);
    const demoTenants = await db.global
      .select()
      .from(tenants)
      .where(
        inArray(
          tenants.slug,
          DEMO_TENANTS.map((t) => t.slug),
        ),
      );
    expect(demoTenants).toHaveLength(2);
    // The old tenant's tickets went with it (cascade), none left orphaned.
    const orphaned = await db.withTenant(before.id, (tx) => tx.select().from(tickets));
    expect(orphaned).toHaveLength(0);
  });
});
