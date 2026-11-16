/**
 * What the worker does with each job. Plain functions over injected
 * dependencies, so tests run them against real Postgres with a fake Notifier.
 * Every handler re-reads current state first: a job describes an intention,
 * not a fact, and the world may have moved on since it was enqueued.
 */
import {
  type Db,
  deleteExpiredSessions,
  deletePushSubscription,
  eq,
  expireCall,
  listPushSubscriptions,
  loadQueueState,
  purgeAllCustomerEmails,
  queues,
  recordNotified,
  tenants,
  tickets,
  ticketsWithSubscriptions,
  wasNotified,
} from "@waitless/db";
import {
  almostUpMessage,
  notificationKind,
  type PushMessage,
  shouldNotifyAlmostUp,
  yourTurnMessage,
} from "@waitless/shared";
import type { FastifyBaseLogger } from "fastify";
import type { QueueEvent } from "../realtime/queue-events.ts";
import type { Notifier } from "./notifier.ts";
import type { AutoNoShowJob, NotifyScanJob, SendPushJob } from "./queues.ts";

export interface ProcessorDeps {
  db: Db;
  /** null when VAPID keys aren't configured: push jobs are skipped. */
  notifier: Notifier | null;
  enqueueSendPush(job: SendPushJob): Promise<void>;
  publish(event: QueueEvent): Promise<void>;
  log: FastifyBaseLogger;
}

export type SendPushOutcome = "sent" | "skipped" | "no-subscriptions";

/** Finds waiting customers who are now "almost up" and haven't been told yet. */
export async function processNotifyScan(deps: ProcessorDeps, job: NotifyScanJob): Promise<number> {
  const due = await deps.db.withTenant(job.tenantId, async (tx) => {
    const [queue] = await tx.select().from(queues).where(eq(queues.id, job.queueId));
    if (!queue) return [];
    const [tenant] = await deps.db.global
      .select({ timezone: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, job.tenantId));
    const state = await loadQueueState(tx, {
      queueId: queue.id,
      timezone: tenant?.timezone ?? "UTC",
    });

    const candidates = state.waiting
      .filter((_, index) => shouldNotifyAlmostUp(index + 1, queue.notifyWhenAhead))
      .map((t) => t.id);
    // Only those who can actually receive a push; the rest cost nothing.
    const subscribed = await ticketsWithSubscriptions(tx, candidates);
    const pending: string[] = [];
    for (const id of candidates) {
      if (subscribed.has(id) && !(await wasNotified(tx, id, notificationKind("almost")))) {
        pending.push(id);
      }
    }
    return pending;
  });

  for (const ticketId of due) {
    await deps.enqueueSendPush({ tenantId: job.tenantId, ticketId, kind: "almost" });
  }
  return due.length;
}

/** Sends one notification, if it is still true and not sent before (dedupe layer 2). */
export async function processSendPush(
  deps: ProcessorDeps,
  job: SendPushJob,
): Promise<SendPushOutcome> {
  const notifier = deps.notifier;
  if (!notifier) {
    deps.log.warn("push not configured (VAPID keys missing); skipping");
    return "skipped";
  }
  const kind =
    job.kind === "almost"
      ? notificationKind("almost")
      : notificationKind("called", job.calledAtMs ?? 0);

  const prepared = await deps.db.withTenant(job.tenantId, async (tx) => {
    const [ticket] = await tx.select().from(tickets).where(eq(tickets.id, job.ticketId));
    if (!ticket) return undefined;
    // Stale? "Almost up" only while waiting; "your turn" only for this very call.
    if (job.kind === "almost" && ticket.status !== "waiting") return undefined;
    if (
      job.kind === "called" &&
      (ticket.status !== "called" || ticket.calledAt?.getTime() !== job.calledAtMs)
    ) {
      return undefined;
    }
    if (await wasNotified(tx, ticket.id, kind)) return undefined;

    const [tenant] = await deps.db.global
      .select({ name: tenants.name, slug: tenants.slug, timezone: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, job.tenantId));
    if (!tenant) return undefined;
    const url = `/q/${tenant.slug}/t/${ticket.publicToken}`;

    let message: PushMessage;
    if (job.kind === "almost") {
      const state = await loadQueueState(tx, {
        queueId: ticket.queueId,
        timezone: tenant.timezone,
      });
      const position = state.waiting.findIndex((t) => t.id === ticket.id) + 1;
      message = almostUpMessage({
        tenantName: tenant.name,
        ahead: Math.max(0, position - 1),
        displayCode: ticket.displayCode,
        url,
      });
    } else {
      message = yourTurnMessage({ tenantName: tenant.name, displayCode: ticket.displayCode, url });
    }
    return { ticket, message, targets: await listPushSubscriptions(tx, ticket.id) };
  });

  if (!prepared) return "skipped";
  if (prepared.targets.length === 0) return "no-subscriptions";

  let delivered = false;
  for (const target of prepared.targets) {
    // Throws on transient failures: BullMQ retries the job with backoff.
    const result = await notifier.send(target, prepared.message);
    if (result === "gone") {
      // The browser unsubscribed or the subscription expired: forget it.
      await deps.db.withTenant(job.tenantId, (tx) => deletePushSubscription(tx, target.id));
    } else {
      delivered = true;
    }
  }
  if (!delivered) return "no-subscriptions";

  await deps.db.withTenant(job.tenantId, (tx) => recordNotified(tx, prepared.ticket, kind));
  return "sent";
}

/** SPEC §6.6: marks no-show only if the ticket is still waiting on this same call. */
export async function processAutoNoShow(deps: ProcessorDeps, job: AutoNoShowJob): Promise<boolean> {
  const expired = await deps.db.withTenant(job.tenantId, async (tx, { afterCommit }) => {
    const ticket = await expireCall(tx, { ticketId: job.ticketId, calledAtMs: job.calledAtMs });
    if (ticket) {
      afterCommit(() =>
        deps.publish({
          type: "ticket.updated",
          tenantId: job.tenantId,
          queueId: ticket.queueId,
          ticketId: ticket.id,
        }),
      );
    }
    return ticket;
  });
  return expired !== undefined;
}

/** Daily retention: customer emails 30 days after the ticket ends; expired sessions. */
export async function processMaintenance(
  deps: ProcessorDeps,
  now = new Date(),
): Promise<{ emailsCleared: number; sessionsDeleted: number }> {
  const emailsCleared = await purgeAllCustomerEmails(deps.db, now);
  const sessionsDeleted = await deleteExpiredSessions(deps.db, now);
  deps.log.info({ emailsCleared, sessionsDeleted }, "retention job finished");
  return { emailsCleared, sessionsDeleted };
}
