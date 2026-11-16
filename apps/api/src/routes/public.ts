/**
 * Customer endpoints, no login (SPEC §11). The ticket's random public token is
 * the capability: whoever has the link can see and cancel that one ticket.
 */
import {
  createTicket,
  type Db,
  eq,
  loadQueueState,
  queues,
  tickets,
  transitionTicket,
} from "@waitless/db";
import {
  ConflictError,
  etaRangeForNewcomer,
  JoinQueueInputSchema,
  JoinQueueResponseSchema,
  NotFoundError,
  PublicQueueInfoSchema,
  PublicTicketViewSchema,
  type TicketStatus,
  toPublicTicketView,
} from "@waitless/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { findQueueBySlug, findTenantBySlug } from "../queue/lookup.ts";
import { toSnapshot } from "../queue/views.ts";

const QueueParams = z.object({ tenantSlug: z.string(), queueSlug: z.string() });
const TicketParams = z.object({ tenantSlug: z.string(), token: z.string().min(1).max(64) });

export const publicRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get(
    "/q/:tenantSlug/:queueSlug",
    {
      schema: {
        tags: ["public"],
        summary: "Queue info shown before joining",
        params: QueueParams,
        response: { 200: PublicQueueInfoSchema },
      },
    },
    async (request) => {
      const tenant = await findTenantBySlug(db, request.params.tenantSlug);
      return db.withTenant(tenant.id, async (tx) => {
        const queue = await findQueueBySlug(tx, request.params.queueSlug);
        const state = await loadQueueState(tx, { queueId: queue.id, timezone: tenant.timezone });
        return {
          tenantName: tenant.name,
          name: queue.name,
          isOpen: queue.isOpen,
          waitingCount: state.waiting.length,
          etaRange: etaRangeForNewcomer(toSnapshot(queue, state)),
        };
      });
    },
  );

  app.post(
    "/q/:tenantSlug/:queueSlug/tickets",
    {
      schema: {
        tags: ["public"],
        summary: "Join the queue",
        params: QueueParams,
        body: JoinQueueInputSchema,
        response: { 201: JoinQueueResponseSchema },
      },
    },
    async (request, reply) => {
      const tenant = await findTenantBySlug(db, request.params.tenantSlug);
      const ticket = await db.withTenant(tenant.id, async (tx) => {
        const queue = await findQueueBySlug(tx, request.params.queueSlug);
        if (!queue.isOpen) {
          throw new ConflictError("This queue isn't taking new customers right now");
        }
        return createTicket(tx, {
          queue,
          timezone: tenant.timezone,
          customerName: request.body.name,
          customerEmail: request.body.email,
          source: "qr",
          actor: { type: "customer", id: null },
        });
      });
      return reply.code(201).send({ token: ticket.publicToken, displayCode: ticket.displayCode });
    },
  );

  app.get(
    "/q/:tenantSlug/t/:token",
    {
      schema: {
        tags: ["public"],
        summary: "A customer's own ticket: status, position, ETA",
        params: TicketParams,
        response: { 200: PublicTicketViewSchema },
      },
    },
    async (request) => {
      const tenant = await findTenantBySlug(db, request.params.tenantSlug);
      return db.withTenant(tenant.id, async (tx) => {
        const [ticket] = await tx
          .select()
          .from(tickets)
          .where(eq(tickets.publicToken, request.params.token));
        if (!ticket) {
          throw new NotFoundError("Ticket not found");
        }
        const [queue] = await tx.select().from(queues).where(eq(queues.id, ticket.queueId));
        if (!queue) {
          throw new NotFoundError("Queue not found");
        }
        const state = await loadQueueState(tx, { queueId: queue.id, timezone: tenant.timezone });
        const view = toPublicTicketView(
          { id: ticket.id, displayCode: ticket.displayCode, status: ticket.status as TicketStatus },
          toSnapshot(queue, state),
        );
        return { tenantName: tenant.name, queueName: queue.name, queueSlug: queue.slug, ...view };
      });
    },
  );

  app.delete(
    "/q/:tenantSlug/t/:token",
    {
      schema: { tags: ["public"], summary: "Leave the queue", params: TicketParams },
    },
    async (request, reply) => {
      const tenant = await findTenantBySlug(db, request.params.tenantSlug);
      await db.withTenant(tenant.id, async (tx) => {
        const [ticket] = await tx
          .select({ id: tickets.id })
          .from(tickets)
          .where(eq(tickets.publicToken, request.params.token));
        if (!ticket) {
          throw new NotFoundError("Ticket not found");
        }
        await transitionTicket(tx, {
          ticketId: ticket.id,
          action: "cancel",
          actor: { type: "customer", id: null },
        });
      });
      return reply.code(204).send();
    },
  );
};
