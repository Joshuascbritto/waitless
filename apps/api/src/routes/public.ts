/**
 * Customer endpoints, no login (SPEC §11). The ticket's random public token is
 * the capability: whoever has the link can see and cancel that one ticket.
 */
import { randomBytes } from "node:crypto";
import {
  createTicket,
  type Db,
  eq,
  findActiveTicketForDevice,
  isUniqueViolation,
  loadQueueState,
  queues,
  savePushSubscription,
  tickets,
  transitionTicket,
} from "@waitless/db";
import {
  ConflictError,
  etaRangeForNewcomer,
  isFinal,
  JoinQueueInputSchema,
  JoinQueueResponseSchema,
  NotFoundError,
  PublicQueueInfoSchema,
  PublicTicketViewSchema,
  PushKeyResponseSchema,
  PushSubscriptionInputSchema,
  type TicketStatus,
} from "@waitless/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { ApiMetrics } from "../observability/metrics.ts";
import { hitLimits } from "../plugins/fixed-window.ts";
import { findQueueBySlug, findTenantBySlug } from "../queue/lookup.ts";
import type { SideEffects } from "../queue/side-effects.ts";
import { statusIn, toCustomerView, toSnapshot } from "../queue/views.ts";
import { MAX_PUBLIC_STREAMS_PER_IP, type Realtime, SseConnection } from "../realtime/index.ts";

const QueueParams = z.object({ tenantSlug: z.string(), queueSlug: z.string() });
const TicketParams = z.object({ tenantSlug: z.string(), token: z.string().min(1).max(64) });

const customer = { type: "customer", id: null } as const;

/**
 * Anonymous device id (SPEC §9). `__Host-`: Secure, host-only, Path=/.
 * Lets the server keep one active ticket per device per queue and rate-limit
 * joins per device instead of per IP (shop Wi-Fi and CGNAT share IPs).
 */
export const DEVICE_COOKIE = "__Host-waitless_device";
const DEVICE_ID = /^[A-Za-z0-9_-]{22}$/;
const TEN_MINUTES = 10 * 60_000;

declare module "fastify" {
  interface FastifyRequest {
    /** Set on every public request; a new random id when the cookie is missing. */
    deviceId: string;
  }
}

export interface PublicRoutesOptions {
  db: Db;
  redis: Redis;
  realtime: Realtime;
  effects: SideEffects;
  metrics: ApiMetrics;
  /** VAPID public key for the browser to subscribe with; null disables push. */
  vapidPublicKey: string | null;
}

const queueKey = (request: FastifyRequest) => {
  const { tenantSlug, queueSlug } = request.params as { tenantSlug: string; queueSlug: string };
  return `${tenantSlug}:${queueSlug}`;
};

export const publicRoutes: FastifyPluginAsyncZod<PublicRoutesOptions> = async (
  app,
  { db, redis, realtime, effects, metrics, vapidPublicKey },
) => {
  app.decorateRequest("deviceId", "");
  app.addHook("onRequest", async (request, reply) => {
    const existing = request.cookies[DEVICE_COOKIE];
    if (existing && DEVICE_ID.test(existing)) {
      request.deviceId = existing;
      return;
    }
    request.deviceId = randomBytes(16).toString("base64url");
    reply.setCookie(DEVICE_COOKIE, request.deviceId, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 365 * 86_400,
    });
  });

  // Two limits on joining (SPEC §9): tight per device, loose per IP as a backstop
  // (a shop's Wi-Fi or a carrier's CGNAT puts many real customers behind one IP).
  const joinLimits = async (request: FastifyRequest, reply: FastifyReply) => {
    const queue = queueKey(request);
    const result = await hitLimits(
      redis,
      [
        { key: `join-device:${queue}:${request.deviceId}`, max: 3, windowMs: TEN_MINUTES },
        { key: `join-ip:${queue}:${request.ip}`, max: 30, windowMs: TEN_MINUTES },
      ],
      request.log,
    );
    if (!result.allowed) {
      reply.header("retry-after", Math.ceil(result.retryAfterMs / 1000));
      throw Object.assign(new Error("Too many attempts to join. Try again in a few minutes"), {
        statusCode: 429,
      });
    }
  };

  app.get(
    "/push/key",
    {
      schema: {
        tags: ["public"],
        summary: "VAPID public key for Web Push",
        response: { 200: PushKeyResponseSchema },
      },
    },
    async () => ({ publicKey: vapidPublicKey }),
  );

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
      preHandler: joinLimits,
      schema: {
        tags: ["public"],
        summary: "Join the queue (200 with the existing ticket if this device already has one)",
        params: QueueParams,
        body: JoinQueueInputSchema,
        response: { 200: JoinQueueResponseSchema, 201: JoinQueueResponseSchema },
      },
    },
    async (request, reply) => {
      const tenant = await findTenantBySlug(db, request.params.tenantSlug);
      const { ticket, created } = await db.withTenant(tenant.id, async (tx, ctx) => {
        const queue = await findQueueBySlug(tx, request.params.queueSlug);
        const device = { queueId: queue.id, deviceId: request.deviceId };

        // Already in line on this device? Hand back that ticket (a double tap, a reload).
        const existing = await findActiveTicketForDevice(tx, device);
        if (existing) return { ticket: existing, created: false };
        if (!queue.isOpen) {
          throw new ConflictError("This queue isn't taking new customers right now");
        }

        try {
          // Savepoint: if a concurrent tap from this device won the unique index,
          // only this insert rolls back and the outer transaction can read the winner.
          const fresh = await tx.transaction((sp) =>
            createTicket(sp, {
              queue,
              timezone: tenant.timezone,
              customerName: request.body.name,
              customerEmail: request.body.email,
              deviceId: request.deviceId,
              source: "qr",
              actor: customer,
            }),
          );
          effects.changed(ctx, {
            type: "ticket.created",
            tenantId: tenant.id,
            queueId: queue.id,
            ticketId: fresh.id,
          });
          return { ticket: fresh, created: true };
        } catch (error) {
          const winner = isUniqueViolation(error)
            ? await findActiveTicketForDevice(tx, device)
            : undefined;
          if (!winner) throw error;
          return { ticket: winner, created: false };
        }
      });
      if (created) metrics.ticketsCreated.inc({ source: "qr" });
      return reply
        .code(created ? 201 : 200)
        .send({ token: ticket.publicToken, displayCode: ticket.displayCode });
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
        return toCustomerView(tenant.name, queue, state, {
          id: ticket.id,
          displayCode: ticket.displayCode,
          status: ticket.status as TicketStatus,
        });
      });
    },
  );

  app.get(
    "/q/:tenantSlug/t/:token/stream",
    {
      schema: {
        tags: ["public"],
        summary: "SSE: `ticket` events with the same payload as GET, on every change",
        params: TicketParams,
      },
    },
    async (request, reply) => {
      // Reserve before any await, so concurrent requests can't all slip past the cap.
      const slot = realtime.streams.reserve(request.ip, MAX_PUBLIC_STREAMS_PER_IP);
      if (!slot) {
        throw Object.assign(new Error("Too many open streams from this address"), {
          statusCode: 429,
        });
      }

      let ticket: { id: string; queueId: string; displayCode: string } | undefined;
      let tenant: Awaited<ReturnType<typeof findTenantBySlug>>;
      try {
        tenant = await findTenantBySlug(db, request.params.tenantSlug);
        const tenantId = tenant.id;
        [ticket] = await db.withTenant(tenantId, (tx) =>
          tx
            .select({ id: tickets.id, queueId: tickets.queueId, displayCode: tickets.displayCode })
            .from(tickets)
            .where(eq(tickets.publicToken, request.params.token)),
        );
        if (!ticket) {
          throw new NotFoundError("Ticket not found");
        }
      } catch (error) {
        slot.release();
        throw error;
      }
      const watched = ticket;

      // From here on the response is a stream; errors can only be logged.
      const stream = new SseConnection(request, reply);
      realtime.streams.add(stream, slot);
      try {
        const stop = await realtime.hub.watch(
          { tenantId: tenant.id, timezone: tenant.timezone, queueId: watched.queueId },
          {
            ticketId: watched.id,
            render: ({ queue, state, finishedStatuses }) => {
              const status = statusIn(state, finishedStatuses, watched.id);
              if (!status) return;
              stream.send(
                "ticket",
                toCustomerView(tenant.name, queue, state, { ...watched, status }),
              );
            },
          },
        );
        stream.onClose(stop);
      } catch (err) {
        request.log.error({ err }, "could not start ticket stream");
        stream.close();
      }
      return reply;
    },
  );

  app.delete(
    "/q/:tenantSlug/t/:token",
    {
      schema: { tags: ["public"], summary: "Leave the queue", params: TicketParams },
    },
    async (request, reply) => {
      const tenant = await findTenantBySlug(db, request.params.tenantSlug);
      await db.withTenant(tenant.id, async (tx, ctx) => {
        const [ticket] = await tx
          .select({ id: tickets.id })
          .from(tickets)
          .where(eq(tickets.publicToken, request.params.token));
        if (!ticket) {
          throw new NotFoundError("Ticket not found");
        }
        const updated = await transitionTicket(tx, {
          ticketId: ticket.id,
          action: "cancel",
          actor: customer,
        });
        effects.changed(ctx, {
          type: "ticket.updated",
          tenantId: tenant.id,
          queueId: updated.queueId,
          ticketId: updated.id,
        });
      });
      return reply.code(204).send();
    },
  );

  app.post(
    "/q/:tenantSlug/t/:token/push",
    {
      schema: {
        tags: ["public"],
        summary: "Save this browser's Web Push subscription for the ticket",
        params: TicketParams,
        body: PushSubscriptionInputSchema,
      },
    },
    async (request, reply) => {
      const tenant = await findTenantBySlug(db, request.params.tenantSlug);
      await db.withTenant(tenant.id, async (tx, ctx) => {
        const [ticket] = await tx
          .select()
          .from(tickets)
          .where(eq(tickets.publicToken, request.params.token));
        if (!ticket) {
          throw new NotFoundError("Ticket not found");
        }
        if (isFinal(ticket.status as TicketStatus)) {
          throw new ConflictError("This ticket is no longer active");
        }
        await savePushSubscription(tx, ticket, {
          endpoint: request.body.endpoint,
          p256dh: request.body.keys.p256dh,
          auth: request.body.keys.auth,
        });
        // They may already be close to the front: scan now instead of at the next change.
        effects.changed(ctx, {
          type: "ticket.updated",
          tenantId: tenant.id,
          queueId: ticket.queueId,
          ticketId: ticket.id,
        });
      });
      return reply.code(204).send();
    },
  );
};
