import { createDb, createPool, pingDatabase } from "@waitless/db";
import { Redis } from "ioredis";
import { buildApp } from "./app.ts";
import { loadEnv } from "./env.ts";
import { JobQueues } from "./jobs/queues.ts";
import { loggerOptions } from "./logging.ts";

const env = loadEnv(process.env);

const pool = createPool(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, {
  // Don't queue commands while disconnected: a readiness ping must fail fast.
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});
// BullMQ needs its own connection settings (it retries commands indefinitely by design).
const jobsConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const jobs = new JobQueues(jobsConnection);
const db = createDb(pool, {
  // Runs after a commit, so the request already succeeded; log, don't throw.
  onAfterCommitError: (err) => app.log.error({ err }, "afterCommit hook failed"),
});

const app = await buildApp({
  logger: loggerOptions(env.LOG_LEVEL),
  trustProxy: env.TRUST_PROXY,
  docs: env.API_DOCS,
  services: {
    db,
    redis,
    jobs,
    appOrigin: env.APP_ORIGIN,
    vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null,
  },
  readinessChecks: [
    { name: "postgres", check: () => pingDatabase(pool) },
    {
      name: "redis",
      check: async () => {
        await redis.ping();
      },
    },
  ],
});

// Without these listeners, an idle-connection error would crash the process
// (pg) or print "Unhandled error event" on every retry (ioredis).
pool.on("error", (err) => app.log.warn({ err }, "postgres pool error"));
redis.on("error", (err) => app.log.warn({ err }, "redis connection error"));
jobsConnection.on("error", (err) => app.log.warn({ err }, "redis (jobs) connection error"));

app.addHook("onClose", async () => {
  await jobs.close();
  await Promise.allSettled([pool.end(), redis.quit(), jobsConnection.quit()]);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, "error during shutdown");
        process.exit(1);
      },
    );
  });
}

await app.listen({ host: env.API_HOST, port: env.API_PORT });
