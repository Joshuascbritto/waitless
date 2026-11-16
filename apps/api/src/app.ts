import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { Db } from "@waitless/db";
import Fastify, { type FastifyInstance, type FastifyServerOptions, LogController } from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { Redis } from "ioredis";
import type { JobQueues } from "./jobs/queues.ts";
import { type ApiMetrics, createApiMetrics } from "./observability/metrics.ts";
import { registerAuth } from "./plugins/auth.ts";
import { registerErrorHandlers } from "./plugins/error-handler.ts";
import { registerOriginCheck } from "./plugins/origin-check.ts";
import { createSideEffects } from "./queue/side-effects.ts";
import { createRealtime } from "./realtime/index.ts";
import { adminRoutes } from "./routes/admin.ts";
import { authRoutes } from "./routes/auth.ts";
import { healthRoutes, type ReadinessCheck } from "./routes/health.ts";
import { publicRoutes } from "./routes/public.ts";
import { tenantRoutes } from "./routes/tenants.ts";

/** Real dependencies behind the product routes. */
export interface Services {
  db: Db;
  redis: Redis;
  /** Background job producer (BullMQ). */
  jobs: JobQueues;
  /** Web Push public key, or null when push isn't configured. */
  vapidPublicKey: string | null;
  /** The web app's origin, the only one allowed to make state-changing requests. */
  appOrigin: string;
}

export interface AppDeps {
  /** pino options, or `false` in tests. */
  logger: NonNullable<FastifyServerOptions["logger"]>;
  /** Dependencies `/api/health/ready` must reach (Postgres, Redis). Fakes in tests. */
  readinessChecks: ReadinessCheck[];
  readinessTimeoutMs?: number;
  trustProxy?: NonNullable<FastifyServerOptions["trustProxy"]>;
  /** Serve the OpenAPI document and Swagger UI at /api/docs (dev and demo only). */
  docs?: boolean;
  /**
   * Product routes (auth, tenants, admin). `server.ts` always passes them.
   * Unit tests of cross-cutting behavior (health, errors, request ids) leave
   * them out so they don't need Postgres and Redis.
   */
  services?: Services;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Prometheus metrics of this instance; served on a separate port by server.ts. */
    metrics: ApiMetrics;
  }
}

const REQUEST_ID_HEADER = "x-request-id";
// Accept an incoming id only if it looks like an id: it ends up in every log line.
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Builds the app without listening on a port. Tests call `app.inject()` on it;
 * `server.ts` wires real dependencies and calls `listen()`.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger,
    logController: new LogController({ requestIdLogLabel: "requestId" }),
    // Which proxies may set X-Forwarded-For; decides what request.ip is (rate limits).
    trustProxy: deps.trustProxy ?? false,
    // Reuse the proxy's/caller's id when it's well-formed, so one request can be
    // followed across hops; otherwise mint a fresh one.
    genReqId: (req) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      return typeof incoming === "string" && VALID_REQUEST_ID.test(incoming)
        ? incoming
        : randomUUID();
    },
  });

  // Routes declare zod schemas (shared with the web app); responses are
  // serialized through them too, so extra fields (e.g. password_hash) can't leak.
  app.decorate("metrics", createApiMetrics());

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook("onRequest", async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  await app.register(helmet);
  registerErrorHandlers(app);

  if (deps.docs) {
    // Must be registered before the routes it documents.
    await app.register(swagger, {
      openapi: {
        info: {
          title: "Waitless API",
          version: "0.1.0",
          description: "Virtual queue for small businesses. Errors are application/problem+json.",
        },
      },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, {
      routePrefix: "/api/docs",
      // Swagger UI ships its own CSP for its static assets; helmet's default would block them.
      staticCSP: true,
    });
  }

  await app.register(healthRoutes, {
    prefix: "/api/health",
    checks: deps.readinessChecks,
    timeoutMs: deps.readinessTimeoutMs ?? 2_000,
  });

  const services = deps.services;
  if (services) {
    registerOriginCheck(app, services.appOrigin);
    await app.register(cookie);
    await app.register(rateLimit, {
      global: false, // only routes that opt in (login now; join queue in Phase 4)
      redis: services.redis,
      nameSpace: "waitless:ratelimit:",
      // If Redis is down, let requests through instead of locking everyone out.
      // Trade-off: brute-force protection pauses during a Redis outage.
      skipOnError: true,
    });
    registerAuth(app, services.db);

    const realtime = createRealtime(services.db, services.redis, app.log);
    app.metrics.trackSseConnections(() => realtime.streams.size);
    // End open streams first, or close() would wait on them forever.
    app.addHook("preClose", async () => realtime.streams.closeAll());
    app.addHook("onClose", async () => realtime.close());

    await app.register(authRoutes, { prefix: "/api/auth", db: services.db });
    await app.register(tenantRoutes, { prefix: "/api/tenants", db: services.db });
    const effects = createSideEffects(realtime, services.jobs);
    await app.register(publicRoutes, {
      prefix: "/api/public",
      db: services.db,
      redis: services.redis,
      realtime,
      effects,
      metrics: app.metrics,
      vapidPublicKey: services.vapidPublicKey,
    });
    await app.register(adminRoutes, {
      prefix: "/api/admin/:tenantSlug",
      db: services.db,
      realtime,
      effects,
      metrics: app.metrics,
    });
  }

  return app;
}
