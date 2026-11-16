/**
 * Background job queues (BullMQ on Redis). The API only enqueues; the worker
 * (src/worker.ts, same image, another command) processes. Every payload
 * carries `tenantId`, so the worker always works inside withTenant().
 */
import { type JobsOptions, Queue } from "bullmq";
import type { Redis } from "ioredis";

export const QUEUE_NAMES = {
  notifications: "notifications",
  timers: "ticket-timers",
  maintenance: "maintenance",
} as const;

export interface NotifyScanJob {
  tenantId: string;
  queueId: string;
}

export interface SendPushJob {
  tenantId: string;
  ticketId: string;
  kind: "almost" | "called";
  /** For "called": which call this is about; a newer call makes the job stale. */
  calledAtMs?: number;
}

export interface AutoNoShowJob {
  tenantId: string;
  ticketId: string;
  calledAtMs: number;
}

/** Custom BullMQ job ids can't contain ':' (it's their Redis key separator). */
const jobId = (...parts: Array<string | number>) => parts.join("-");

const SEND_PUSH_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2_000 },
  // Kept for a day: while the job exists, an identical enqueue is ignored (dedupe layer 1).
  removeOnComplete: { age: 86_400 },
  removeOnFail: { age: 7 * 86_400 },
};

export class JobQueues {
  readonly notifications: Queue;
  readonly timers: Queue;
  readonly maintenance: Queue;

  /** `connection` must have maxRetriesPerRequest: null, as BullMQ requires. */
  constructor(connection: Redis) {
    this.notifications = new Queue(QUEUE_NAMES.notifications, { connection });
    this.timers = new Queue(QUEUE_NAMES.timers, { connection });
    this.maintenance = new Queue(QUEUE_NAMES.maintenance, { connection });
  }

  /**
   * Someone's position may have changed: check who is now "almost up".
   * Debounced per queue: changes within 300 ms become one scan, and since the
   * scan runs after that window it reads a state that includes all of them.
   */
  async notifyScan(job: NotifyScanJob): Promise<void> {
    await this.notifications.add("notify-scan", job, {
      delay: 300,
      deduplication: { id: jobId("scan", job.queueId), ttl: 300 },
      removeOnComplete: true,
      removeOnFail: { age: 86_400 },
    });
  }

  async sendPush(job: SendPushJob): Promise<void> {
    await this.notifications.add("send-push", job, {
      ...SEND_PUSH_OPTIONS,
      jobId: jobId("push", job.ticketId, job.kind, job.calledAtMs ?? "once"),
    });
  }

  /** SPEC §6.6: one delayed job per call, identified by that call's timestamp. */
  async scheduleNoShow(job: AutoNoShowJob, afterMinutes: number): Promise<void> {
    await this.timers.add("auto-no-show", job, {
      delay: afterMinutes * 60_000,
      jobId: jobId("no-show", job.ticketId, job.calledAtMs),
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: { age: 7 * 86_400 },
    });
  }

  async close(): Promise<void> {
    await Promise.all([this.notifications.close(), this.timers.close(), this.maintenance.close()]);
  }
}
