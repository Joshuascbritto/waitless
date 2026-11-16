import type { FastifyPluginAsync } from "fastify";

export interface ReadinessCheck {
  name: string;
  check: () => Promise<void>;
}

export interface HealthRoutesOptions {
  checks: ReadinessCheck[];
  timeoutMs: number;
}

type CheckStatus = "ok" | "fail";

export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (app, options) => {
  // Liveness: can the process answer at all? It never touches dependencies,
  // so a Postgres or Redis outage doesn't make Kubernetes restart every pod.
  app.get("/live", async () => ({ status: "ok" }));

  // Readiness: can this instance serve real traffic right now? On 503 the
  // load balancer stops sending requests here until the checks pass again.
  app.get("/ready", async (request, reply) => {
    const results = await Promise.all(
      options.checks.map(async ({ name, check }): Promise<[string, CheckStatus]> => {
        try {
          await withTimeout(check(), options.timeoutMs);
          return [name, "ok"];
        } catch (err) {
          request.log.warn({ err, check: name }, "readiness check failed");
          return [name, "fail"];
        }
      }),
    );

    const ready = results.every(([, status]) => status === "ok");
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ok" : "unavailable",
      checks: Object.fromEntries(results),
    });
  });
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
