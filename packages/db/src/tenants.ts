import { sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { memberships, tenants } from "./schema.ts";

export interface NewTenant {
  name: string;
  slug: string;
  timezone: string;
}

export type Tenant = typeof tenants.$inferSelect;

/**
 * Creates a tenant and makes `ownerId` its owner, atomically.
 *
 * The tenant id only exists after the insert, so the tenant context is set
 * mid-transaction instead of through withTenant(). `tenants` is a global
 * table; the membership insert must pass the memberships RLS WITH CHECK.
 */
export async function createTenantWithOwner(
  db: Db,
  input: NewTenant,
  ownerId: string,
): Promise<Tenant> {
  return db.global.transaction(async (tx) => {
    const [tenant] = await tx.insert(tenants).values(input).returning();
    if (!tenant) {
      throw new Error("tenant insert returned no row");
    }
    await tx.execute(sql`select set_config('app.tenant_id', ${tenant.id}, true)`);
    await tx.insert(memberships).values({ tenantId: tenant.id, userId: ownerId, role: "owner" });
    return tenant;
  });
}
