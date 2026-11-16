/**
 * Cross-replica fan-out over Redis pub/sub (SPEC §7, ADR-0004).
 *
 * Any replica that changes a queue publishes a tiny event (ids only, no
 * personal data) after its transaction commits. Every replica with clients
 * watching that queue receives it and refreshes them. Each replica holds at
 * most ONE Redis subscription per queue, reference-counted across its clients.
 */
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";

export const QueueEventSchema = z.object({
  type: z.enum(["ticket.created", "ticket.updated", "queue.updated"]),
  tenantId: z.uuid(),
  queueId: z.uuid(),
  ticketId: z.uuid().optional(),
});
export type QueueEvent = z.infer<typeof QueueEventSchema>;

export type QueueEventListener = (event: QueueEvent) => void;

export const channelFor = (queueId: string) => `waitless:queue:${queueId}`;

/** Publish without a subscriber, for processes that only announce changes (the worker). */
export async function publishQueueEvent(redis: Redis, event: QueueEvent): Promise<void> {
  await redis.publish(channelFor(event.queueId), JSON.stringify(event));
}

export class QueueEvents {
  readonly #publisher: Redis;
  readonly #subscriber: Redis;
  readonly #log: FastifyBaseLogger;
  readonly #listeners = new Map<string, Set<QueueEventListener>>();

  /**
   * @param publisher any connection; used for PUBLISH only.
   * @param subscriber a dedicated connection: in subscribe mode Redis accepts
   *   no other commands on it. ioredis re-subscribes after a reconnect.
   */
  constructor(publisher: Redis, subscriber: Redis, log: FastifyBaseLogger) {
    this.#publisher = publisher;
    this.#subscriber = subscriber;
    this.#log = log;
    subscriber.on("message", (channel, message) => this.#dispatch(channel, message));
  }

  async publish(event: QueueEvent): Promise<void> {
    await publishQueueEvent(this.#publisher, event);
  }

  /** Starts listening to one queue. Resolves once Redis confirmed the subscription. */
  async subscribe(queueId: string, listener: QueueEventListener): Promise<() => Promise<void>> {
    const channel = channelFor(queueId);
    let listeners = this.#listeners.get(channel);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(channel, listeners);
    }
    listeners.add(listener);
    // First local listener for this queue: subscribe on Redis. Later ones share it.
    if (listeners.size === 1) {
      await this.#subscriber.subscribe(channel);
    }

    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      const current = this.#listeners.get(channel);
      current?.delete(listener);
      if (current && current.size === 0) {
        this.#listeners.delete(channel);
        await this.#subscriber.unsubscribe(channel);
      }
    };
  }

  /** Number of queues this instance is subscribed to. */
  get subscribedQueues(): number {
    return this.#listeners.size;
  }

  #dispatch(channel: string, message: string): void {
    const listeners = this.#listeners.get(channel);
    if (!listeners) return;
    const parsed = QueueEventSchema.safeParse(JSON.parse(message));
    if (!parsed.success) {
      this.#log.warn({ channel }, "ignoring malformed queue event");
      return;
    }
    for (const listener of listeners) {
      listener(parsed.data);
    }
  }
}
