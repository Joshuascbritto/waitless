/**
 * SPEC §12.2 — mandatory RLS isolation test, against a real Postgres 18
 * bootstrapped and migrated exactly like production.
 */
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.ts";
import { pgErrorCode } from "./errors.ts";
import { memberships, queues, ticketEvents, tickets, users } from "./schema.ts";
import { createTenantWithOwner } from "./tenants.ts";
import { startTestDatabase, type TestDatabase } from "./testing.ts";

let database: TestDatabase;
let pool: pg.Pool;
let db: Db;

const ids = {
  tenantA: "",
  tenantB: "",
  userA: "",
  userB: "",
  ticketA: "",
  ticketB: "",
};

async function seedTenant(slug: string, ownerEmail: string) {
  const [owner] = await db.global
    .insert(users)
    .values({ email: ownerEmail, name: slug, passwordHash: "x" })
    .returning();
  if (!owner) throw new Error("user insert failed");
  const tenant = await createTenantWithOwner(
    db,
    { name: slug, slug, timezone: "America/Bahia" },
    owner.id,
  );

  const ticketId = await db.withTenant(tenant.id, async (tx) => {
    const [queue] = await tx
      .insert(queues)
      .values({ tenantId: tenant.id, name: "Haircut", slug: "haircut" })
      .returning();
    if (!queue) throw new Error("queue insert failed");
    const [ticket] = await tx
      .insert(tickets)
      .values({
        tenantId: tenant.id,
        queueId: queue.id,
        publicToken: `token-${slug}`,
        number: 1,
        displayCode: "A-001",
        customerName: "Ana",
        source: "qr",
        sortKey: "1",
      })
      .returning();
    if (!ticket) throw new Error("ticket insert failed");
    await tx.insert(ticketEvents).values({
      tenantId: tenant.id,
      ticketId: ticket.id,
      queueId: queue.id,
      type: "joined",
      actorType: "customer",
    });
    return ticket.id;
  });

  return { tenantId: tenant.id, userId: owner.id, ticketId };
}

beforeAll(async () => {
  database = await startTestDatabase();
  pool = new pg.Pool({ connectionString: database.appUrl, max: 1 });
  db = createDb(pool);

  const a = await seedTenant("tenant-a", "a@example.com");
  const b = await seedTenant("tenant-b", "b@example.com");
  ids.tenantA = a.tenantId;
  ids.userA = a.userId;
  ids.ticketA = a.ticketId;
  ids.tenantB = b.tenantId;
  ids.userB = b.userId;
  ids.ticketB = b.ticketId;

  // userA is also staff at tenant B, to test cross-tenant membership reads.
  await db.withTenant(ids.tenantB, (tx) =>
    tx.insert(memberships).values({ tenantId: ids.tenantB, userId: ids.userA, role: "staff" }),
  );
});

afterAll(async () => {
  await pool?.end();
  await database?.stop();
});

describe("tenant-scoped tables, as waitless_app", () => {
  it("only shows the current tenant's rows", async () => {
    const rows = await db.withTenant(ids.tenantA, (tx) => tx.select().from(tickets));

    expect(rows.map((t) => t.id)).toEqual([ids.ticketA]);
  });

  it("can't update another tenant's row, even by primary key", async () => {
    const updated = await db.withTenant(ids.tenantA, (tx) =>
      tx
        .update(tickets)
        .set({ customerName: "hacked" })
        .where(eq(tickets.id, ids.ticketB))
        .returning(),
    );

    expect(updated).toHaveLength(0);
    const [ticketB] = await db.withTenant(ids.tenantB, (tx) =>
      tx.select().from(tickets).where(eq(tickets.id, ids.ticketB)),
    );
    expect(ticketB?.customerName).toBe("Ana");
  });

  it("can't delete another tenant's row", async () => {
    const deleted = await db.withTenant(ids.tenantA, (tx) =>
      tx.delete(tickets).where(eq(tickets.id, ids.ticketB)).returning(),
    );

    expect(deleted).toHaveLength(0);
  });

  it("rejects inserting a row for another tenant (WITH CHECK)", async () => {
    const attempt = db.withTenant(ids.tenantA, (tx) =>
      tx.insert(queues).values({ tenantId: ids.tenantB, name: "Sneaky", slug: "sneaky" }),
    );

    await expect(attempt).rejects.toSatisfy((error) => pgErrorCode(error) === "42501");
  });

  it("returns zero rows with no tenant set (fails closed)", async () => {
    expect(await db.global.select().from(tickets)).toHaveLength(0);
    expect(await db.global.select().from(queues)).toHaveLength(0);
  });

  it("doesn't leak the tenant to the next transaction on the same pooled connection", async () => {
    // The pool has a single connection, so both statements run on the same session.
    await db.withTenant(ids.tenantA, (tx) => tx.select().from(tickets));

    // The setting is now '' (not NULL) on this session; must still mean "no tenant", not an error.
    const leaked = await db.global.select().from(tickets);
    expect(leaked).toHaveLength(0);
  });

  it("keeps ticket_events append-only", async () => {
    const attempt = db.withTenant(ids.tenantA, (tx) =>
      tx.update(ticketEvents).set({ type: "done" }).where(eq(ticketEvents.ticketId, ids.ticketA)),
    );

    await expect(attempt).rejects.toSatisfy((error) => pgErrorCode(error) === "42501");
  });
});

describe("memberships (dual-key policy)", () => {
  it("shows a user their own memberships across tenants, and nobody else's", async () => {
    const rows = await db.withUser(ids.userA, (tx) => tx.select().from(memberships));

    expect(rows.every((m) => m.userId === ids.userA)).toBe(true);
    expect(rows.map((m) => m.tenantId).sort()).toEqual([ids.tenantA, ids.tenantB].sort());
  });

  it("shows a tenant's whole team within the tenant context", async () => {
    const rows = await db.withTenant(ids.tenantB, (tx) => tx.select().from(memberships));

    expect(rows.map((m) => m.userId).sort()).toEqual([ids.userA, ids.userB].sort());
  });

  it("refuses to insert a membership without tenant context", async () => {
    const attempt = db.withUser(ids.userB, (tx) =>
      tx.insert(memberships).values({ tenantId: ids.tenantA, userId: ids.userB, role: "owner" }),
    );

    await expect(attempt).rejects.toSatisfy((error) => pgErrorCode(error) === "42501");
  });

  it("returns zero rows with no context", async () => {
    expect(await db.global.select().from(memberships)).toHaveLength(0);
  });
});

describe("table owner", () => {
  it("is filtered too, because of FORCE ROW LEVEL SECURITY", async () => {
    const ownerPool = new pg.Pool({ connectionString: database.ownerUrl, max: 1 });
    try {
      const { rows } = await ownerPool.query("select count(*)::int as n from tickets");
      expect(rows[0].n).toBe(0);
    } finally {
      await ownerPool.end();
    }
  });

  it("is the only role that can create tables", async () => {
    const attempt = db.global.execute(sql`create table sneaky (id int)`);

    await expect(attempt).rejects.toSatisfy((error) => pgErrorCode(error) === "42501");
  });
});
