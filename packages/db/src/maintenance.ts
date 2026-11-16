/** Data retention (SPEC §5): personal data doesn't outlive its purpose. */
import { and, isNotNull, lt, sql } from "drizzle-orm";
import type { Db, Tx } from "./client.ts";
import { sessions, tenants, tickets } from "./schema.ts";

export const PII_RETENTION_DAYS = 30;

/** Clears customer emails of tickets that finished before `cutoff`, in the current tenant. */
export async function purgeCustomerEmails(tx: Tx, cutoff: Date): Promise<number> {
  const rows = await tx
    .update(tickets)
    .set({ customerEmail: null })
    .where(
      and(
        isNotNull(tickets.customerEmail),
        isNotNull(tickets.finishedAt),
        lt(tickets.finishedAt, cutoff),
      ),
    )
    .returning({ id: tickets.id });
  return rows.length;
}

/**
 * Runs purgeCustomerEmails for every tenant, each inside its own withTenant:
 * no role bypasses RLS, not even maintenance (SPEC §9).
 */
export async function purgeAllCustomerEmails(
  db: Db,
  now: Date,
  retentionDays = PII_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const all = await db.global.select({ id: tenants.id }).from(tenants);
  let cleared = 0;
  for (const tenant of all) {
    cleared += await db.withTenant(tenant.id, (tx) => purgeCustomerEmails(tx, cutoff));
  }
  return cleared;
}

/** Sessions are a global table; expired rows are useless and only grow it. */
export async function deleteExpiredSessions(db: Db, now: Date): Promise<number> {
  const rows = await db.global
    .delete(sessions)
    .where(lt(sessions.expiresAt, sql`${now.toISOString()}::timestamptz`))
    .returning({ id: sessions.id });
  return rows.length;
}
