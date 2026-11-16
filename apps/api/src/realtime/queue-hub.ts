/**
 * Per-instance hub between Redis events and connected SSE clients (SPEC §7).
 *
 * On each event for a queue, the hub runs ONE query for that queue and every
 * watcher renders its own payload from the result in memory: the cost is one
 * query per event per instance, not one per client. While a refresh is
 * running, further events only mark the queue dirty and trigger a single
 * follow-up refresh, so a burst of clicks can't become a burst of queries.
 */
import {
  type Db,
  eq,
  inArray,
  loadQueueState,
  type QueueRow,
  type QueueState,
  queues,
  tickets,
} from "@waitless/db";
import type { TicketStatus } from "@waitless/shared";
import type { FastifyBaseLogger } from "fastify";
import type { QueueEvents } from "./queue-events.ts";

export interface QueueContext {
  queue: QueueRow;
  state: QueueState;
  /** Status of watched tickets that are no longer active (done, cancelled…). */
  finishedStatuses: ReadonlyMap<string, TicketStatus>;
}

export interface Watcher {
  /** Customer watchers name their ticket, so the hub can look it up once it leaves the active lists. */
  ticketId?: string;
  render(context: QueueContext): void;
}

export interface QueueScope {
  tenantId: string;
  timezone: string;
  queueId: string;
}

interface Entry extends QueueScope {
  watchers: Set<Watcher>;
  subscribed: Promise<() => Promise<void>>;
  refreshing: boolean;
  dirty: boolean;
}

export class QueueHub {
  readonly #db: Db;
  readonly #events: QueueEvents;
  readonly #log: FastifyBaseLogger;
  readonly #entries = new Map<string, Entry>();

  constructor(db: Db, events: QueueEvents, log: FastifyBaseLogger) {
    this.#db = db;
    this.#events = events;
    this.#log = log;
  }

  /**
   * Adds a watcher and sends it the current state. The Redis subscription is
   * confirmed BEFORE the snapshot is read, so no change can slip in between.
   * Returns a function that removes the watcher.
   */
  async watch(scope: QueueScope, watcher: Watcher): Promise<() => void> {
    let entry = this.#entries.get(scope.queueId);
    if (!entry) {
      const queueId = scope.queueId;
      entry = {
        ...scope,
        watchers: new Set(),
        subscribed: this.#events.subscribe(queueId, () => void this.#refresh(queueId)),
        refreshing: false,
        dirty: false,
      };
      this.#entries.set(queueId, entry);
    }
    entry.watchers.add(watcher);
    const current = entry;

    try {
      await current.subscribed;
      watcher.render(await this.#load(current));
    } catch (error) {
      this.#remove(current, watcher);
      throw error;
    }
    return () => this.#remove(current, watcher);
  }

  /** Queues with at least one watcher on this instance. */
  get watchedQueues(): number {
    return this.#entries.size;
  }

  #remove(entry: Entry, watcher: Watcher): void {
    entry.watchers.delete(watcher);
    if (entry.watchers.size > 0 || this.#entries.get(entry.queueId) !== entry) return;
    this.#entries.delete(entry.queueId);
    entry.subscribed
      .then((unsubscribe) => unsubscribe())
      .catch((err: unknown) =>
        this.#log.warn({ err, queueId: entry.queueId }, "unsubscribe failed"),
      );
  }

  async #refresh(queueId: string): Promise<void> {
    const entry = this.#entries.get(queueId);
    if (!entry) return;
    if (entry.refreshing) {
      entry.dirty = true;
      return;
    }
    entry.refreshing = true;
    try {
      do {
        entry.dirty = false;
        const context = await this.#load(entry);
        for (const watcher of entry.watchers) {
          try {
            watcher.render(context);
          } catch (err) {
            this.#log.error({ err, queueId }, "SSE watcher failed to render");
          }
        }
      } while (entry.dirty);
    } catch (err) {
      this.#log.error({ err, queueId }, "queue refresh failed");
    } finally {
      entry.refreshing = false;
    }
  }

  /** The one query per refresh (two when a watched ticket just finished). */
  #load(entry: Entry): Promise<QueueContext> {
    return this.#db.withTenant(entry.tenantId, async (tx) => {
      const [queue] = await tx.select().from(queues).where(eq(queues.id, entry.queueId));
      if (!queue) {
        throw new Error(`queue ${entry.queueId} disappeared`);
      }
      const state = await loadQueueState(tx, { queueId: queue.id, timezone: entry.timezone });

      const active = new Set(
        [...state.waiting, ...state.called, ...state.serving].map((t) => t.id),
      );
      const missing = [...entry.watchers]
        .map((w) => w.ticketId)
        .filter((id): id is string => id !== undefined && !active.has(id));
      const finishedStatuses = new Map<string, TicketStatus>();
      if (missing.length > 0) {
        const rows = await tx
          .select({ id: tickets.id, status: tickets.status })
          .from(tickets)
          .where(inArray(tickets.id, missing));
        for (const row of rows) finishedStatuses.set(row.id, row.status as TicketStatus);
      }
      return { queue, state, finishedStatuses };
    });
  }
}
