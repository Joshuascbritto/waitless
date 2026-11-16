/** Database rows → API shapes. Dates become ISO strings; private columns are left out. */
import type { QueueRow, QueueState, TicketRow } from "@waitless/db";
import {
  type AdminTicket,
  type Board,
  type PublicTicketViewResponse,
  type Queue,
  type QueueSnapshot,
  type TicketStatus,
  toPublicTicketView,
} from "@waitless/shared";

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

/** The customer's own ticket, as sent by GET and by the SSE stream (same redacted shape). */
export function toCustomerView(
  tenantName: string,
  queue: QueueRow,
  state: QueueState,
  ticket: { id: string; displayCode: string; status: TicketStatus },
): PublicTicketViewResponse {
  const view = toPublicTicketView(ticket, toSnapshot(queue, state));
  return { tenantName, queueName: queue.name, queueSlug: queue.slug, ...view };
}

/** Current status of a ticket: from the active lists, else from the finished lookup. */
export function statusIn(
  state: QueueState,
  finished: ReadonlyMap<string, TicketStatus>,
  ticketId: string,
): TicketStatus | undefined {
  const active = [...state.waiting, ...state.called, ...state.serving].find(
    (t) => t.id === ticketId,
  );
  return (active?.status as TicketStatus | undefined) ?? finished.get(ticketId);
}

/** The staff board, as sent by GET and by the SSE stream. */
export function toBoard(queue: QueueRow, state: QueueState): Board {
  return {
    queue: toQueue(queue),
    waiting: state.waiting.map(toAdminTicket),
    called: state.called.map(toAdminTicket),
    serving: state.serving.map(toAdminTicket),
  };
}
