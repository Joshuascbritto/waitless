import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "./client.ts";
import { isUniqueViolation } from "./errors.ts";
import { tenants, users } from "./schema.ts";
import { createTenantWithOwner } from "./tenants.ts";
import { startTestDatabase, type TestDatabase } from "./testing.ts";

let database: TestDatabase;
let pool: pg.Pool;
let db: Db;
let userId: string;
let tenantId: string;

beforeAll(async () => {
  database = await startTestDatabase();
  pool = new pg.Pool({ connectionString: database.appUrl, max: 2 });
  db = createDb(pool);

  const [user] = await db.global
    .insert(users)
    .values({ email: "owner@example.com", name: "Owner", passwordHash: "x" })
    .returning();
  if (!user) throw new Error("user insert failed");
  userId = user.id;
  const tenant = await createTenantWithOwner(
    db,
    { name: "Shop", slug: "shop", timezone: "America/Bahia" },
    userId,
  );
  tenantId = tenant.id;
});

afterAll(async () => {
  await pool?.end();
  await database?.stop();
});

describe("withTenant", () => {
  it("runs afterCommit hooks after the commit, in order", async () => {
    const calls: string[] = [];

    const result = await db.withTenant(tenantId, async (_tx, { afterCommit }) => {
      afterCommit(() => {
        calls.push("first");
      });
      afterCommit(() => {
        calls.push("second");
      });
      calls.push("body");
      return 42;
    });

    expect(result).toBe(42);
    expect(calls).toEqual(["body", "first", "second"]);
  });

  it("skips afterCommit hooks and rolls back when the body throws", async () => {
    const hook = vi.fn();

    const attempt = db.withTenant(tenantId, async (tx, { afterCommit }) => {
      afterCommit(hook);
      await tx.update(tenants).set({ name: "Renamed" }).where(eq(tenants.id, tenantId));
      throw new Error("boom");
    });

    await expect(attempt).rejects.toThrow("boom");
    expect(hook).not.toHaveBeenCalled();
    const [tenant] = await db.global.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(tenant?.name).toBe("Shop");
  });

  it("reports a failing hook instead of failing the committed call", async () => {
    const onAfterCommitError = vi.fn();
    const reportingDb = createDb(pool, { onAfterCommitError });

    const result = await reportingDb.withTenant(tenantId, async (_tx, { afterCommit }) => {
      afterCommit(() => {
        throw new Error("redis down");
      });
      return "committed";
    });

    expect(result).toBe("committed");
    expect(onAfterCommitError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "redis down" }),
    );
  });

  it("rejects a tenant id that isn't a UUID before touching SQL", async () => {
    await expect(db.withTenant("1 or 1=1", async () => null)).rejects.toThrow(TypeError);
  });
});

describe("createTenantWithOwner", () => {
  it("rejects a duplicate slug without leaving a partial tenant behind", async () => {
    const attempt = createTenantWithOwner(
      db,
      { name: "Copy", slug: "shop", timezone: "America/Bahia" },
      userId,
    );

    await expect(attempt).rejects.toSatisfy(isUniqueViolation);
    const named = await db.global.select().from(tenants).where(eq(tenants.name, "Copy"));
    expect(named).toHaveLength(0);
  });
});
