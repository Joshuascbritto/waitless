import type { Db } from "@waitless/db";
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";
import { QueueEvents } from "./queue-events.ts";
import { QueueHub } from "./queue-hub.ts";
import { SseRegistry } from "./sse.ts";

export { channelFor, type QueueEvent, QueueEvents } from "./queue-events.ts";
export { type QueueContext, QueueHub, type Watcher } from "./queue-hub.ts";
export { SseConnection, SseRegistry } from "./sse.ts";

/** Concurrent public streams one IP may hold (SPEC §9); generous for shared shop Wi-Fi. */
export const MAX_PUBLIC_STREAMS_PER_IP = 50;

export interface Realtime {
  events: QueueEvents;
  hub: QueueHub;
  streams: SseRegistry;
  close(): Promise<void>;
}

/**
 * Wires one instance's real-time parts. `redis` is the shared command
 * connection (used to publish); a dedicated duplicate subscribes.
 */
export function createRealtime(db: Db, redis: Redis, log: FastifyBaseLogger): Realtime {
  // Subscribing must work even before the first connect completes, so this
  // connection queues commands while offline, unlike the command connection.
  const subscriber = redis.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null });
  subscriber.on("error", (err) => log.warn({ err }, "redis subscriber error"));

  const events = new QueueEvents(redis, subscriber, log);
  const streams = new SseRegistry();
  return {
    events,
    hub: new QueueHub(db, events, log),
    streams,
    close: async () => {
      streams.closeAll();
      await subscriber.quit().catch(() => subscriber.disconnect());
    },
  };
}
