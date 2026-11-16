/**
 * Queue operations (SPEC §6). Every function takes a transaction from
 * withTenant(), so RLS scopes it to one tenant. Rules (which moves are legal,
 * where a push-back lands) come from the pure functions in @waitless/shared;
 * this module only turns them into SQL that stays correct under concurrency.
 */
import { randomBytes } from "node:crypto";
import {
  canTransition,
  formatDisplayCode,
  fromStatesFor,
  InvalidTransitionError,
  isFinal,
  NotFoundError,
  nextStatus,
  pushBackSortKey,
  type TicketAction,
  type TicketStatus,
} from "@waitless/shared";
import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Tx } from "./client.ts";
import { pushSubscriptions, queueCounters, type queues, ticketEvents, tickets } from "./schema.ts";

export type QueueRow = typeof queues.$inferSelect;
export type TicketRow = typeof tickets.$inferSelect;

export interface Actor {
  type: "customer" | "staff" | "system";
  /** User id for staff; null for customers and the system. */
  id: string | null;
}

type EventType = (typeof ticketEvents.$inferInsert)["type"];

async function recordEvent(
  tx: Tx,
  ticket: Pick<TicketRow, "tenantId" | "id" | "queueId">,
  type: EventType,
  actor: Actor,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await tx.insert(ticketEvents).values({
    tenantId: ticket.tenantId,
    ticketId: ticket.id,
    queueId: ticket.queueId,
    type,
    actorType: actor.type,
    actorId: actor.id,
    payload,
  });
}

/**
 * Next ticket number for today in the tenant's timezone (SPEC §6.2). One
 * atomic upsert: concurrent joins serialize on the counter row, so numbers
 * never repeat or skip. `at` exists for tests; production uses the DB clock.
 */
export async function allocateTicketNumber(
  tx: Tx,
  input: { tenantId: string; queueId: string; timezone: string; at?: Date },
): Promise<number> {
  const at: SQL = input.at ? sql`${input.at.toISOString()}::timestamptz` : sql`now()`;
  const [row] = await tx
    .insert(queueCounters)
    .values({
      tenantId: input.tenantId,
      queueId: input.queueId,
      day: sql`(${at} at time zone ${input.timezone})::date`,
      lastNumber: 1,
    })
    .onConflictDoUpdate({
      target: [queueCounters.queueId, queueCounters.day],
      set: { lastNumber: sql`${queueCounters.lastNumber} + 1` },
    })
    .returning({ number: queueCounters.lastNumber });
  if (!row) {
    throw new Error("ticket number allocation returned no row");
  }
  return row.number;
}

export interface NewTicket {
  queue: QueueRow;
  timezone: string;
  customerName: string;
  customerEmail?: string | null | undefined;
  source: "qr" | "walk_in";
  /** Anonymous device cookie; with the unique index, one active ticket per device per queue. */
  deviceId?: string | null | undefined;
  actor: Actor;
  /** Tests only: pretend the ticket is created at this instant (numbering day). */
  at?: Date;
}

/** Adds a ticket at the end of the line and logs `joined`. */
export async function createTicket(tx: Tx, input: NewTicket): Promise<TicketRow> {
  const { queue } = input;
  const number = await allocateTicketNumber(tx, {
    tenantId: queue.tenantId,
    queueId: queue.id,
    timezone: input.timezone,
    ...(input.at ? { at: input.at } : {}),
  });

  const [ticket] = await tx
    .insert(tickets)
    .values({
      tenantId: queue.tenantId,
      queueId: queue.id,
      // 128 random bits: the customer's capability to see and leave their ticket.
      publicToken: randomBytes(16).toString("base64url"),
      number,
      displayCode: formatDisplayCode(queue.prefix, number),
      customerName: input.customerName,
      customerEmail: input.customerEmail ?? null,
      deviceId: input.deviceId ?? null,
      source: input.source,
      status: "waiting",
      // Join time in epoch ms, from the database clock: one clock for all API replicas.
      sortKey: sql`extract(epoch from now()) * 1000`,
    })
    .returning();
  if (!ticket) {
    throw new Error("ticket insert returned no row");
  }
  await recordEvent(tx, ticket, "joined", input.actor, { source: input.source });
  return ticket;
}

/**
 * Calls the first waiting ticket (SPEC §6.4). `FOR UPDATE SKIP LOCKED`: when
 * two staff click at once, the second transaction skips the row the first one
 * locked and takes the next. Nobody blocks, nobody gets the same ticket.
 * Returns undefined when the queue is empty.
 */
export async function callNext(
  tx: Tx,
  input: { queueId: string; staffId: string },
): Promise<TicketRow | undefined> {
  const [ticket] = await tx
    .update(tickets)
    .set({ status: "called", calledAt: sql`now()`, calledBy: input.staffId })
    .where(
      eq(
        tickets.id,
        sql`(
          select id from ${tickets}
          where ${tickets.queueId} = ${input.queueId} and ${tickets.status} = 'waiting'
          order by ${tickets.sortKey}, ${tickets.id}
          limit 1
          for update skip locked
        )`,
      ),
    )
    .returning();
  if (ticket) {
    await recordEvent(tx, ticket, "called", { type: "staff", id: input.staffId });
  }
  return ticket;
}

/** Columns each action stamps, besides the status. */
function stampsFor(action: TicketAction, actor: Actor): PgUpdateSetSource<typeof tickets> {
  switch (action) {
    case "call":
      return { calledAt: sql`now()`, calledBy: actor.id };
    case "start":
      return { servingAt: sql`now()` };
    default:
      return { finishedAt: sql`now()` };
  }
}

/**
 * Applies `action` to one ticket (everything except push-back). A single
 * conditional UPDATE — `WHERE status = ANY(allowed sources)` — so the legality
 * check and the write are atomic: if two staff act on the same ticket, exactly
 * one wins and the other gets a 409, never a corrupted state.
 */
export async function transitionTicket(
  tx: Tx,
  input: { ticketId: string; action: Exclude<TicketAction, "push_back">; actor: Actor },
): Promise<TicketRow> {
  const { ticketId, action, actor } = input;
  const sources = fromStatesFor(action);
  const target = sources[0] && nextStatus(sources[0], action);
  if (!target) {
    throw new Error(`no transition defined for ${action}`);
  }

  const [ticket] = await tx
    .update(tickets)
    .set({ status: target, ...stampsFor(action, actor) })
    .where(and(eq(tickets.id, ticketId), inArray(tickets.status, sources)))
    .returning();

  if (!ticket) {
    const [current] = await tx
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, ticketId));
    if (!current) {
      throw new NotFoundError("Ticket not found");
    }
    throw new InvalidTransitionError(current.status as TicketStatus, action);
  }

  // Event names match the status reached: called, serving, done, no_show, cancelled, removed.
  await recordEvent(tx, ticket, target, actor);
  if (isFinal(target)) {
    // Push subscriptions are personal data with no further use (SPEC §5).
    await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.ticketId, ticket.id));
  }
  return ticket;
}

/**
 * Called customer isn't here yet: back to waiting, behind the next `n` people
 * (SPEC §6.3). The ticket row is locked first, so a concurrent action on it
 * waits; the new key comes from the pure pushBackSortKey().
 */
export async function pushBack(
  tx: Tx,
  input: { ticketId: string; n: number; actor: Actor },
): Promise<TicketRow> {
  const [ticket] = await tx
    .select()
    .from(tickets)
    .where(eq(tickets.id, input.ticketId))
    .for("update");
  if (!ticket) {
    throw new NotFoundError("Ticket not found");
  }
  if (!canTransition(ticket.status as TicketStatus, "push_back")) {
    throw new InvalidTransitionError(ticket.status as TicketStatus, "push_back");
  }

  const ahead = await tx
    .select({ sortKey: tickets.sortKey })
    .from(tickets)
    .where(and(eq(tickets.queueId, ticket.queueId), eq(tickets.status, "waiting")))
    .orderBy(asc(tickets.sortKey), asc(tickets.id))
    .limit(input.n + 1);

  const [updated] = await tx
    .update(tickets)
    .set({
      status: "waiting",
      sortKey: pushBackSortKey(
        ahead.map((row) => row.sortKey),
        input.n,
        ticket.sortKey,
      ),
      pushCount: sql`${tickets.pushCount} + 1`,
    })
    .where(eq(tickets.id, ticket.id))
    .returning();
  if (!updated) {
    throw new Error("push-back update returned no row");
  }
  await recordEvent(tx, updated, "pushed_back", input.actor, { n: input.n });
  return updated;
}

export interface QueueState {
  /** In queue order: (sort_key, id). */
  waiting: TicketRow[];
  called: TicketRow[];
  serving: TicketRow[];
  /** Today's (tenant timezone) last 20 service durations in minutes, oldest first. */
  recentServiceMinutes: number[];
}

/** Active tickets plus recent service times: the input for the board, positions and ETAs. */
export async function loadQueueState(
  tx: Tx,
  input: { queueId: string; timezone: string },
): Promise<QueueState> {
  const active = await tx
    .select()
    .from(tickets)
    .where(
      and(
        eq(tickets.queueId, input.queueId),
        inArray(tickets.status, ["waiting", "called", "serving"]),
      ),
    )
    .orderBy(asc(tickets.sortKey), asc(tickets.id));

  const durations = await tx.execute<{ minutes: string }>(sql`
    select extract(epoch from (${tickets.finishedAt} - ${tickets.servingAt})) / 60 as minutes
    from ${tickets}
    where ${tickets.queueId} = ${input.queueId}
      and ${tickets.status} = 'done'
      and ${tickets.servingAt} is not null
      and (${tickets.finishedAt} at time zone ${input.timezone})::date
        = (now() at time zone ${input.timezone})::date
    order by ${tickets.finishedAt} desc
    limit 20
  `);

  const byTime = (key: "calledAt" | "servingAt") => (a: TicketRow, b: TicketRow) =>
    (a[key]?.getTime() ?? 0) - (b[key]?.getTime() ?? 0);

  return {
    waiting: active.filter((t) => t.status === "waiting"),
    called: active.filter((t) => t.status === "called").sort(byTime("calledAt")),
    serving: active.filter((t) => t.status === "serving").sort(byTime("servingAt")),
    recentServiceMinutes: durations.rows.map((row) => Number(row.minutes)).reverse(),
  };
}

/** This device's active ticket in this queue, if any (SPEC §9). */
export async function findActiveTicketForDevice(
  tx: Tx,
  input: { queueId: string; deviceId: string },
): Promise<TicketRow | undefined> {
  const [ticket] = await tx
    .select()
    .from(tickets)
    .where(
      and(
        eq(tickets.queueId, input.queueId),
        eq(tickets.deviceId, input.deviceId),
        inArray(tickets.status, ["waiting", "called", "serving"]),
      ),
    );
  return ticket;
}

/**
 * The auto no-show (SPEC §6.6). Marks the ticket no-show only if it is still
 * `called` by the SAME call: a push-back followed by a new call changes
 * called_at, so an older delayed job matches nothing and does nothing.
 * Compared at millisecond precision, because that is what the job carries
 * (JavaScript dates), while Postgres stores microseconds.
 */
export async function expireCall(
  tx: Tx,
  input: { ticketId: string; calledAtMs: number },
): Promise<TicketRow | undefined> {
  const [ticket] = await tx
    .update(tickets)
    .set({ status: "no_show", finishedAt: sql`now()` })
    .where(
      and(
        eq(tickets.id, input.ticketId),
        eq(tickets.status, "called"),
        sql`floor(extract(epoch from ${tickets.calledAt}) * 1000) = ${input.calledAtMs}`,
      ),
    )
    .returning();
  if (ticket) {
    await recordEvent(tx, ticket, "no_show", { type: "system", id: null }, { reason: "timeout" });
    await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.ticketId, ticket.id));
  }
  return ticket;
}
