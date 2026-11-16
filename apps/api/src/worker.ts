/**
 * Background worker: same image as the API, started with `node dist/worker.js`.
 * Processes notification, timer and maintenance jobs. Scales independently of
 * the API; any number of workers can run, BullMQ hands each job to one.
 */
import { createDb, createPool } from "@waitless/db";
import { Redis } from "ioredis";
import { pino } from "pino";
import { loadWorkerEnv } from "./env.ts";
import { type Notifier, WebPushNotifier } from "./jobs/notifier.ts";
import { JobQueues } from "./jobs/queues.ts";
import { scheduleMaintenance, startWorkers } from "./jobs/workers.ts";
import { publishQueueEvent } from "./realtime/queue-events.ts";

const env = loadWorkerEnv(process.env);
const log = pino({ level: env.LOG_LEVEL, base: { service: "worker" } });

const pool = createPool(env.DATABASE_URL);
pool.on("error", (err) => log.warn({ err }, "postgres pool error"));
const db = createDb(pool, {
  onAfterCommitError: (err) => log.error({ err }, "afterCommit hook failed"),
});

const connections: Redis[] = [];
const connect = () => {
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  connection.on("error", (err) => log.warn({ err }, "redis connection error"));
  connections.push(connection);
  return connection;
};
const jobs = new JobQueues(connect());
const publisher = connect();

let notifier: Notifier | null = null;
if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT) {
  notifier = new WebPushNotifier({
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT,
  });
} else {
  log.warn("VAPID keys not set: push notifications are disabled (run `pnpm vapid:generate`)");
}

const workers = startWorkers(
  {
    db,
    notifier,
    enqueueSendPush: (job) => jobs.sendPush(job),
    publish: (event) => publishQueueEvent(publisher, event),
    log,
  },
  connect,
);
await scheduleMaintenance(jobs);
log.info("worker started");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    log.info({ signal }, "shutting down");
    // close() waits for running jobs to finish; unfinished ones are retried by another worker.
    await Promise.allSettled(workers.map((w) => w.close()));
    await jobs.close();
    await Promise.allSettled([pool.end(), ...connections.map((c) => c.quit())]);
    process.exit(0);
  });
}
