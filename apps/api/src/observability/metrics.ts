/**
 * Prometheus metrics (SPEC §14). Each app or worker gets its own registry
 * (no global default registry), so tests can build several instances side by
 * side. Served by `startMetricsServer` on an internal port that the Ingress
 * never routes to: metrics reveal traffic patterns and aren't for the public.
 */
import { createServer, type Server } from "node:http";
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";

export interface ApiMetrics {
  registry: Registry;
  /** Tickets committed, by source ("qr" or "walk_in"). */
  ticketsCreated: Counter<"source">;
  /** Wall time of "call next", by outcome ("called", "empty", "error"). */
  callNextDuration: Histogram<"outcome">;
  /** Reads the live number of open SSE streams at scrape time. */
  trackSseConnections(read: () => number): void;
}

export function createApiMetrics(): ApiMetrics {
  const registry = new Registry();
  let readSse: () => number = () => 0;
  new Gauge({
    name: "waitless_sse_connections",
    help: "Open Server-Sent Events streams on this instance",
    registers: [registry],
    collect() {
      this.set(readSse());
    },
  });
  return {
    registry,
    ticketsCreated: new Counter({
      name: "waitless_tickets_created_total",
      help: "Tickets created (committed), by source",
      labelNames: ["source"],
      registers: [registry],
    }),
    callNextDuration: new Histogram({
      name: "waitless_call_next_duration_seconds",
      help: "Time to call the next customer, transaction included",
      labelNames: ["outcome"],
      // Mostly a few ms; the tail shows lock contention or a slow database.
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [registry],
    }),
    trackSseConnections(read) {
      readSse = read;
    },
  };
}

export interface WorkerMetrics {
  registry: Registry;
  /** Jobs finished, by BullMQ queue and result ("completed" or "failed"). */
  jobsProcessed: Counter<"queue" | "result">;
}

export function createWorkerMetrics(): WorkerMetrics {
  const registry = new Registry();
  return {
    registry,
    jobsProcessed: new Counter({
      name: "waitless_jobs_processed_total",
      help: "Background jobs finished, by queue and result",
      labelNames: ["queue", "result"],
      registers: [registry],
    }),
  };
}

/** Process metrics (CPU, memory, event loop lag, GC). Production entrypoints only. */
export function collectProcessMetrics(registry: Registry): void {
  collectDefaultMetrics({ register: registry });
}

/**
 * GET /metrics on its own port. Plain node:http, not Fastify: it must keep
 * answering even if the app's plugins misbehave, and it has one route.
 */
export async function startMetricsServer(
  registry: Registry,
  options: { host: string; port: number },
): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/metrics") {
      res.writeHead(404).end();
      return;
    }
    registry.metrics().then(
      (body) => res.writeHead(200, { "content-type": registry.contentType }).end(body),
      () => res.writeHead(500).end(),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });
  return server;
}
