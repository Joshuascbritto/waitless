/** Database rows → API shapes. Dates become ISO strings; private columns are left out. */
import type { QueueRow, QueueState, TicketRow } from "@waitless/db";
import type { AdminTicket, Queue, QueueSnapshot, TicketStatus } from "@waitless/shared";

export function toQueue(row: QueueRow): Queue {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    prefix: row.prefix,
    isOpen: row.isOpen,
    activeServers: row.activeServers,
    defaultServiceMinutes: row.defaultServiceMinutes,
    notifyWhenAhead: row.notifyWhenAhead,
    noShowAfterMinutes: row.noShowAfterMinutes,
  };
}

/** Staff view of a ticket. No public token: staff never needs the customer's capability. */
export function toAdminTicket(row: TicketRow): AdminTicket {
  return {
    id: row.id,
    displayCode: row.displayCode,
    customerName: row.customerName,
    customerEmail: row.customerEmail,
    source: row.source as AdminTicket["source"],
    status: row.status as TicketStatus,
    pushCount: row.pushCount,
    joinedAt: row.joinedAt.toISOString(),
    calledAt: row.calledAt?.toISOString() ?? null,
    servingAt: row.servingAt?.toISOString() ?? null,
  };
}

/** Input for the pure position/ETA functions in @waitless/shared. */
export function toSnapshot(queue: QueueRow, state: QueueState, now = new Date()): QueueSnapshot {
  return {
    activeServers: queue.activeServers,
    defaultServiceMinutes: queue.defaultServiceMinutes,
    waiting: state.waiting,
    called: state.called,
    serving: state.serving.map((t) => ({
      id: t.id,
      displayCode: t.displayCode,
      servingAt: t.servingAt ?? now,
    })),
    recentServiceMinutes: state.recentServiceMinutes,
    now,
  };
}
