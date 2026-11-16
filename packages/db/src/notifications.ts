/** Push subscriptions and the "already notified" record (SPEC §8). */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "./client.ts";
import type { TicketRow } from "./queue.ts";
import { pushSubscriptions, ticketEvents } from "./schema.ts";

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;

/** Saves a browser's push subscription for a ticket; the same endpoint again replaces its keys. */
export async function savePushSubscription(
  tx: Tx,
  ticket: Pick<TicketRow, "tenantId" | "id">,
  input: PushSubscriptionInput,
): Promise<void> {
  await tx
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.ticketId, ticket.id),
        eq(pushSubscriptions.endpoint, input.endpoint),
      ),
    );
  await tx
    .insert(pushSubscriptions)
    .values({ tenantId: ticket.tenantId, ticketId: ticket.id, ...input });
}

export function listPushSubscriptions(tx: Tx, ticketId: string): Promise<PushSubscriptionRow[]> {
  return tx.select().from(pushSubscriptions).where(eq(pushSubscriptions.ticketId, ticketId));
}

/** Tickets (among `ticketIds`) with at least one push subscription. */
export async function ticketsWithSubscriptions(tx: Tx, ticketIds: string[]): Promise<Set<string>> {
  if (ticketIds.length === 0) return new Set();
  const rows = await tx
    .selectDistinct({ ticketId: pushSubscriptions.ticketId })
    .from(pushSubscriptions)
    .where(inArray(pushSubscriptions.ticketId, ticketIds));
  return new Set(rows.map((r) => r.ticketId));
}

export async function deletePushSubscription(tx: Tx, id: string): Promise<void> {
  await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id));
}

export async function wasNotified(tx: Tx, ticketId: string, kind: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: ticketEvents.id })
    .from(ticketEvents)
    .where(
      and(
        eq(ticketEvents.ticketId, ticketId),
        eq(ticketEvents.type, "notified"),
        sql`${ticketEvents.payload} ->> 'kind' = ${kind}`,
      ),
    );
  return row !== undefined;
}

/**
 * Records a sent notification. The unique partial index on
 * (ticket_id, payload->>'kind') WHERE type = 'notified' makes a second record
 * of the same kind a no-op. Returns false when it was already recorded.
 */
export async function recordNotified(
  tx: Tx,
  ticket: Pick<TicketRow, "tenantId" | "id" | "queueId">,
  kind: string,
): Promise<boolean> {
  const inserted = await tx
    .insert(ticketEvents)
    .values({
      tenantId: ticket.tenantId,
      ticketId: ticket.id,
      queueId: ticket.queueId,
      type: "notified",
      actorType: "system",
      payload: { kind },
    })
    .onConflictDoNothing()
    .returning({ id: ticketEvents.id });
  return inserted.length > 0;
}
