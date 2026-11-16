# 0004. Redis pub/sub for cross-replica fan-out
Date: 2026-11-16
Status: Accepted

## Context

The API runs as two or more stateless replicas behind a load balancer. A customer's SSE stream (ADR-0002) is held by whichever replica the balancer picked, while the staff click that changes their ticket may land on another replica. Every replica with clients watching a queue must learn about every change to it, within milliseconds.

Redis is already part of the stack (rate limiting now, BullMQ jobs in Phase 4).

## Options considered

1. **Sticky sessions** (route all traffic of a queue to one replica)
   - Pros: no messaging.
   - Cons: actions and streams come from different people and devices, so stickiness can't put them on the same replica; uneven load; a replica restart drops a whole queue.
2. **Postgres `LISTEN/NOTIFY`**
   - Pros: no extra system; can be sent inside the transaction and delivered on commit.
   - Cons: each listening replica holds a dedicated connection outside the pool (awkward with poolers like PgBouncer in transaction mode); ties real-time load to the primary database.
3. **Each replica polls the database for changes**
   - Pros: no messaging.
   - Cons: latency vs. load trade-off again, multiplied by replicas × queues.
4. **Redis pub/sub**
   - Pros: already deployed; sub-millisecond delivery; channels per queue keep traffic targeted; ioredis re-subscribes after reconnects.
   - Cons: fire-and-forget: a replica disconnected from Redis misses messages (mitigated below); one more dependency on the real-time path.
5. **A durable log** (Redis Streams, Kafka, NATS JetStream)
   - Pros: replayable.
   - Cons: replay isn't needed (clients always get a fresh snapshot); more operational weight.

## Decision

Option 4.

- **Publish after commit.** Every state change registers `afterCommit(() => publish(...))` inside `withTenant`; publishing inside the transaction could announce a change that then rolls back. Channel `waitless:queue:{queueId}`, payload `{ type, tenantId, queueId, ticketId }`: ids only, never personal data, so nothing sensitive sits in Redis.
- **One subscription per queue per replica**, reference-counted across that replica's clients: subscribe with the first watcher, unsubscribe with the last. The subscriber is a dedicated Redis connection (subscribe mode can't run other commands). Verified with `PUBSUB NUMSUB` in tests.
- **One query per event per replica, not per client.** On a message, the replica's hub runs one `loadQueueState` for that queue and each connected client's payload is computed from it in memory. While a refresh is running, further events only mark the queue dirty and trigger one follow-up refresh, so a burst of clicks causes at most two queries per replica.
- **Missed messages are bounded.** If Redis drops, ioredis reconnects and re-subscribes; streams also reconnect and receive a full snapshot. The payload carries no state, only "something changed", so a lost message delays an update until the next change or reconnect but never corrupts it.

**Proof**: the mandatory test (SPEC §12.4, `apps/api/src/realtime/realtime.test.ts`) runs two API instances in one process against the same Postgres and Redis; a customer streams from instance B over real HTTP, staff act through instance A, and the customer receives the change. Also demonstrated with `docker compose --profile full` (two replicas behind Caddy): a stream on `api-1` received the update from a `call-next` served by `api-2`. And on Kubernetes (ADR-0008) through Traefik, with the stream and the action on different pods.

## Consequences

- Easier: replicas can be added or restarted freely; the real-time path costs O(events × replicas) queries, independent of how many clients watch.
- Harder: Redis becomes part of the real-time path; it needs monitoring and, at scale, replication (managed Redis).
- A single very busy queue concentrates load on its channel; fine at small-business scale. At 10,000 shops, revisit: shard Redis by queue id, or coalesce refreshes over a short window (e.g. 100 ms) per queue.
