import { randomUUID } from "node:crypto";
import helmet from "@fastify/helmet";
import Fastify, { type FastifyInstance, type FastifyServerOptions, LogController } from "fastify";
import { registerErrorHandlers } from "./plugins/error-handler.ts";
import { healthRoutes, type ReadinessCheck } from "./routes/health.ts";

export interface AppDeps {
  /** pino options, or `false` in tests. */
  logger: NonNullable<FastifyServerOptions["logger"]>;
  /** Dependencies `/api/health/ready` must reach (Postgres, Redis). Fakes in tests. */
  readinessChecks: ReadinessCheck[];
  readinessTimeoutMs?: number;
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
    // Reuse the proxy's/caller's id when it's well-formed, so one request can be
    // followed across hops; otherwise mint a fresh one.
    genReqId: (req) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      return typeof incoming === "string" && VALID_REQUEST_ID.test(incoming)
        ? incoming
        : randomUUID();
    },
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  await app.register(helmet);
  registerErrorHandlers(app);

  await app.register(healthRoutes, {
    prefix: "/api/health",
    checks: deps.readinessChecks,
    timeoutMs: deps.readinessTimeoutMs ?? 2_000,
  });

  return app;
}
