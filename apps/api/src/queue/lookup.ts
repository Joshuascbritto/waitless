import { and, type Db, eq, type QueueRow, queues, type Tx, tenants } from "@waitless/db";
import { NotFoundError } from "@waitless/shared";

export interface TenantRef {
  id: string;
  name: string;
  slug: string;
  timezone: string;
}

/** Public routes: tenants are global (not RLS-scoped), so they resolve before any tenant context. */
export async function findTenantBySlug(db: Db, slug: string): Promise<TenantRef> {
  const [tenant] = await db.global
    .select({ id: tenants.id, name: tenants.name, slug: tenants.slug, timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.slug, slug));
  if (!tenant) {
    throw new NotFoundError("Business not found");
  }
  return tenant;
}

export async function findQueueBySlug(tx: Tx, slug: string): Promise<QueueRow> {
  const [queue] = await tx.select().from(queues).where(eq(queues.slug, slug));
  if (!queue) {
    throw new NotFoundError("Queue not found");
  }
  return queue;
}

/** By id. RLS already limits it to the current tenant; the tenant filter is defense in depth. */
export async function findQueue(tx: Tx, tenantId: string, queueId: string): Promise<QueueRow> {
  const [queue] = await tx
    .select()
    .from(queues)
    .where(and(eq(queues.id, queueId), eq(queues.tenantId, tenantId)));
  if (!queue) {
    throw new NotFoundError("Queue not found");
  }
  return queue;
}
