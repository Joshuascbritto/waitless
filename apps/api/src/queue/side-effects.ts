/**
 * What happens after a queue change commits. Routes register these as
 * afterCommit hooks, so nothing is announced or scheduled for a change that
 * rolled back.
 */
import type { QueueRow, ScopedContext, TicketRow } from "@waitless/db";
import type { JobQueues } from "../jobs/queues.ts";
import type { QueueEvent, Realtime } from "../realtime/index.ts";

export interface SideEffects {
  /** Real-time fan-out to every replica, then an "almost up" scan of the queue. */
  changed(ctx: ScopedContext, event: QueueEvent): void;
  /** A ticket was called: tell the customer, and start its no-show timer. */
  called(ctx: ScopedContext, queue: QueueRow, ticket: TicketRow): void;
}

export function createSideEffects(realtime: Realtime, jobs: JobQueues): SideEffects {
  return {
    changed(ctx, event) {
      ctx.afterCommit(() => realtime.events.publish(event));
      ctx.afterCommit(() => jobs.notifyScan({ tenantId: event.tenantId, queueId: event.queueId }));
    },
    called(ctx, queue, ticket) {
      if (!ticket.calledAt) return;
      const calledAtMs = ticket.calledAt.getTime();
      const job = { tenantId: ticket.tenantId, ticketId: ticket.id, calledAtMs };
      ctx.afterCommit(() => jobs.sendPush({ ...job, kind: "called" }));
      ctx.afterCommit(() => jobs.scheduleNoShow(job, queue.noShowAfterMinutes));
    },
  };
}
