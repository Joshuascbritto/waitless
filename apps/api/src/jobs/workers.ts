import { type Job, Worker } from "bullmq";
import type { Redis } from "ioredis";
import {
  type ProcessorDeps,
  processAutoNoShow,
  processMaintenance,
  processNotifyScan,
  processSendPush,
} from "./processors.ts";
import {
  type AutoNoShowJob,
  type JobQueues,
  type NotifyScanJob,
  QUEUE_NAMES,
  type SendPushJob,
} from "./queues.ts";

/** Starts one BullMQ worker per queue. Each gets its own blocking connection. */
export function startWorkers(deps: ProcessorDeps, connection: () => Redis): Worker[] {
  const notifications = new Worker(
    QUEUE_NAMES.notifications,
    async (job: Job) => {
      if (job.name === "notify-scan") return processNotifyScan(deps, job.data as NotifyScanJob);
      if (job.name === "send-push") return processSendPush(deps, job.data as SendPushJob);
      throw new Error(`unknown notifications job ${job.name}`);
    },
    { connection: connection(), concurrency: 10 },
  );
  const timers = new Worker(
    QUEUE_NAMES.timers,
    async (job: Job) => processAutoNoShow(deps, job.data as AutoNoShowJob),
    { connection: connection(), concurrency: 10 },
  );
  const maintenance = new Worker(QUEUE_NAMES.maintenance, async () => processMaintenance(deps), {
    connection: connection(),
  });

  const workers = [notifications, timers, maintenance];
  for (const worker of workers) {
    worker.on("failed", (job, err) =>
      deps.log.warn(
        { err, queue: worker.name, job: job?.name, attempts: job?.attemptsMade },
        "job failed",
      ),
    );
  }
  return workers;
}

/** The retention job runs daily at 03:00 UTC. Upserting is idempotent across restarts and replicas. */
export async function scheduleMaintenance(queues: JobQueues): Promise<void> {
  await queues.maintenance.upsertJobScheduler(
    "daily-retention",
    { pattern: "0 3 * * *", tz: "UTC" },
    { name: "retention", opts: { removeOnComplete: true, removeOnFail: { age: 7 * 86_400 } } },
  );
}
