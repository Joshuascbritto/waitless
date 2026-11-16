/**
 * Everything under /api/admin/:tenantSlug. The two preHandlers below run for
 * every route in this scope, so no admin route can forget the membership
 * check; each handler then works inside withTenant(), so RLS backs it up.
 */
import {
  callNext,
  createTicket,
  type Db,
  eq,
  isUniqueViolation,
  loadQueueState,
  pushBack,
  queues,
  transitionTicket,
} from "@waitless/db";
import {
  AdminTicketSchema,
  BoardSchema,
  ConflictError,
  CreateQueueInputSchema,
  ForbiddenError,
  PushBackInputSchema,
  QueueListResponseSchema,
  QueueSchema,
  type TenantContext,
  TenantContextSchema,
  TICKET_ACTION_PATHS,
  UpdateQueueInputSchema,
  WalkInInputSchema,
} from "@waitless/shared";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { findQueue } from "../queue/lookup.ts";
import { toAdminTicket, toBoard, toQueue } from "../queue/views.ts";
import { type QueueEvent, type Realtime, SseConnection } from "../realtime/index.ts";

// Params must include tenantSlug: validation replaces request.params, and the
// membership preHandler reads it afterwards.
const TenantParams = z.object({ tenantSlug: z.string() });
const QueueParams = TenantParams.extend({ queueId: z.uuid() });
const TicketActionParams = TenantParams.extend({
  ticketId: z.uuid(),
  action: z.enum(Object.keys(TICKET_ACTION_PATHS) as [keyof typeof TICKET_ACTION_PATHS]),
});
const TicketResponse = z.object({ ticket: AdminTicketSchema });

function context(request: FastifyRequest): TenantContext {
  if (!request.tenantContext) {
    throw new Error("requireTenantMember did not set request.tenantContext");
  }
  return request.tenantContext;
}

function staffId(request: FastifyRequest): string {
  if (!request.user) {
    throw new Error("requireUser did not set request.user");
  }
  return request.user.id;
}

/** Staff run the board; only owners change how a queue works. */
function requireOwner(request: FastifyRequest): void {
  if (context(request).role !== "owner") {
    throw new ForbiddenError("Only the owner can change queue settings");
  }
}

const rethrowSlugConflict = (error: unknown): never => {
  throw isUniqueViolation(error)
    ? new ConflictError("This business already has a queue at that address")
    : error;
};

export const adminRoutes: FastifyPluginAsyncZod<{ db: Db; realtime: Realtime }> = async (
  app,
  { db, realtime },
) => {
  /** Announce a change to every replica, only once the transaction has committed. */
  const announce = (event: QueueEvent) => () => realtime.events.publish(event);

  app.addHook("preHandler", app.requireUser);
  app.addHook("preHandler", app.requireTenantMember);

  const tags = ["admin"];

  app.get(
    "/",
    {
      schema: { tags, params: TenantParams, response: { 200: TenantContextSchema } },
    },
    async (request) => context(request),
  );

  // --- Queue settings ------------------------------------------------------------

  app.get(
    "/queues",
    {
      schema: { tags, params: TenantParams, response: { 200: QueueListResponseSchema } },
    },
    async (request) => {
      const { tenant } = context(request);
      const rows = await db.withTenant(tenant.id, (tx) =>
        tx.select().from(queues).where(eq(queues.tenantId, tenant.id)).orderBy(queues.name),
      );
      return { queues: rows.map(toQueue) };
    },
  );

  app.post(
    "/queues",
    {
      schema: {
        tags,
        summary: "Create a queue (owner)",
        params: TenantParams,
        body: CreateQueueInputSchema,
        response: { 201: QueueSchema },
      },
    },
    async (request, reply) => {
      requireOwner(request);
      const { tenant } = context(request);
      const [row] = await db
        .withTenant(tenant.id, (tx) =>
          tx
            .insert(queues)
            .values({ ...request.body, tenantId: tenant.id })
            .returning(),
        )
        .catch(rethrowSlugConflict);
      if (!row) {
        throw new Error("queue insert returned no row");
      }
      return reply.code(201).send(toQueue(row));
    },
  );

  app.patch(
    "/queues/:queueId",
    {
      schema: {
        tags,
        summary: "Change queue settings (owner)",
        params: QueueParams,
        body: UpdateQueueInputSchema,
        response: { 200: QueueSchema },
      },
    },
    async (request) => {
      requireOwner(request);
      const { tenant } = context(request);
      const row = await db
        .withTenant(tenant.id, async (tx, { afterCommit }) => {
          const queue = await findQueue(tx, tenant.id, request.params.queueId);
          if (Object.keys(request.body).length === 0) {
            return queue;
          }
          // Open/closed, servers and service time change what everyone sees.
          afterCommit(announce({ type: "queue.updated", tenantId: tenant.id, queueId: queue.id }));
          const [updated] = await tx
            .update(queues)
            .set(request.body)
            .where(eq(queues.id, queue.id))
            .returning();
          return updated ?? queue;
        })
        .catch(rethrowSlugConflict);
      return toQueue(row);
    },
  );

  // --- Board and actions -------------------------------------------------------------

  app.get(
    "/queues/:queueId/board",
    {
      schema: {
        tags,
        summary: "Live board: waiting, called, serving",
        params: QueueParams,
        response: { 200: BoardSchema },
      },
    },
    async (request) => {
      const { tenant } = context(request);
      return db.withTenant(tenant.id, async (tx) => {
        const queue = await findQueue(tx, tenant.id, request.params.queueId);
        const state = await loadQueueState(tx, { queueId: queue.id, timezone: tenant.timezone });
        return toBoard(queue, state);
      });
    },
  );

  app.get(
    "/queues/:queueId/stream",
    {
      schema: {
        tags,
        summary: "SSE: a `board` event with the whole board on connect and on every change",
        params: QueueParams,
      },
    },
    async (request, reply) => {
      const { tenant } = context(request);
      // Resolve (and 404) before the response turns into a stream.
      const queue = await db.withTenant(tenant.id, (tx) =>
        findQueue(tx, tenant.id, request.params.queueId),
      );

      const stream = new SseConnection(request, reply);
      realtime.streams.add(stream);
      try {
        const stop = await realtime.hub.watch(
          { tenantId: tenant.id, timezone: tenant.timezone, queueId: queue.id },
          // The whole board every time: it's a few dozen rows, and the browser
          // never has to merge partial updates (a push-back reorders the line).
          { render: (ctx) => stream.send("board", toBoard(ctx.queue, ctx.state)) },
        );
        stream.onClose(stop);
      } catch (err) {
        request.log.error({ err }, "could not start board stream");
        stream.close();
      }
      return reply;
    },
  );

  app.post(
    "/queues/:queueId/call-next",
    {
      schema: {
        tags,
        summary: "Call the next waiting customer (204 when the queue is empty)",
        params: QueueParams,
        response: { 200: TicketResponse, 204: z.null() },
      },
    },
    async (request, reply) => {
      const { tenant } = context(request);
      const ticket = await db.withTenant(tenant.id, async (tx, { afterCommit }) => {
        const queue = await findQueue(tx, tenant.id, request.params.queueId);
        const called = await callNext(tx, { queueId: queue.id, staffId: staffId(request) });
        if (called) {
          afterCommit(
            announce({
              type: "ticket.updated",
              tenantId: tenant.id,
              queueId: queue.id,
              ticketId: called.id,
            }),
          );
        }
        return called;
      });
      if (!ticket) {
        return reply.code(204).send(null);
      }
      return { ticket: toAdminTicket(ticket) };
    },
  );

  app.post(
    "/queues/:queueId/walk-ins",
    {
      schema: {
        tags,
        summary: "Add a customer without a phone",
        params: QueueParams,
        body: WalkInInputSchema,
        response: { 201: TicketResponse },
      },
    },
    async (request, reply) => {
      const { tenant } = context(request);
      const ticket = await db.withTenant(tenant.id, async (tx, { afterCommit }) => {
        const queue = await findQueue(tx, tenant.id, request.params.queueId);
        const created = await createTicket(tx, {
          queue,
          timezone: tenant.timezone,
          customerName: request.body.name,
          source: "walk_in",
          actor: { type: "staff", id: staffId(request) },
        });
        afterCommit(
          announce({
            type: "ticket.created",
            tenantId: tenant.id,
            queueId: queue.id,
            ticketId: created.id,
          }),
        );
        return created;
      });
      return reply.code(201).send({ ticket: toAdminTicket(ticket) });
    },
  );

  app.post(
    "/tickets/:ticketId/:action",
    {
      schema: {
        tags,
        summary: "call | start | finish | push-back | no-show | remove",
        params: TicketActionParams,
        // Only push-back takes a body; without one Fastify passes null, hence nullish.
        body: PushBackInputSchema.nullish(),
        response: { 200: TicketResponse },
      },
    },
    async (request) => {
      const { tenant } = context(request);
      const action = TICKET_ACTION_PATHS[request.params.action];
      const actor = { type: "staff" as const, id: staffId(request) };
      const ticket = await db.withTenant(tenant.id, async (tx, { afterCommit }) => {
        const updated =
          action === "push_back"
            ? await pushBack(tx, {
                ticketId: request.params.ticketId,
                n: request.body?.n ?? 2,
                actor,
              })
            : await transitionTicket(tx, { ticketId: request.params.ticketId, action, actor });
        afterCommit(
          announce({
            type: "ticket.updated",
            tenantId: tenant.id,
            queueId: updated.queueId,
            ticketId: updated.id,
          }),
        );
        return updated;
      });
      return { ticket: toAdminTicket(ticket) };
    },
  );
};
