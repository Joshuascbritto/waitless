# 0003. Concurrency-safe "call next" with `FOR UPDATE SKIP LOCKED`
Date: 2026-11-16
Status: Accepted

## Context

A barbershop with three chairs has three barbers who each click **Call next** when they free up. Clicks land at the same moment more often than intuition suggests, especially right after a rush. Two staff must never be handed the same customer, a click must never fail just because someone else clicked too, and nobody should wait on someone else's click.

The API runs as two or more stateless replicas, so the guarantee must come from the database, not from a lock in one process.

## Options considered

1. **Read, then update** (`SELECT` the first waiting ticket, then `UPDATE` it)
   - Pros: obvious code.
   - Cons: both transactions read the same row; both update it; one customer is called twice and the next one is skipped. Wrong.
2. **`SELECT ... FOR UPDATE`** (without `SKIP LOCKED`)
   - Pros: correct.
   - Cons: the second transaction blocks until the first commits, then re-reads a row that is no longer `waiting` and must retry. Under load, clicks serialize behind each other.
3. **`SERIALIZABLE` isolation with retries**
   - Pros: correct for any logic.
   - Cons: conflicts surface as serialization failures the application has to retry; more moving parts for a one-statement problem.
4. **Application or Redis lock per queue**
   - Pros: works across replicas.
   - Cons: a second system to keep consistent with the database; lock expiry and crash edge cases; still serializes all clicks.
5. **One `UPDATE` whose target comes from `SELECT ... FOR UPDATE SKIP LOCKED`**
   - Pros: correct and non-blocking. Each transaction locks the first row nobody else has locked, so concurrent callers take consecutive customers in queue order. One round-trip, no retries.
   - Cons: Postgres-specific; while one transaction holds row 1, another can take row 2 first, so commits may finish slightly out of order (harmless: both customers are called).

## Decision

Option 5:

```sql
UPDATE tickets SET status = 'called', called_at = now(), called_by = $staff
WHERE id = (
  SELECT id FROM tickets
  WHERE queue_id = $queue AND status = 'waiting'
  ORDER BY sort_key, id
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

Zero rows means the queue is empty and the API answers `204`. The order is `(sort_key, id)`, backed by the partial index `tickets_waiting_order_idx ON (queue_id, sort_key, id) WHERE status = 'waiting'`, so the subquery reads one index entry.

The same principle covers every other transition: one conditional `UPDATE ... WHERE id = $1 AND status = ANY($allowed)`, where `$allowed` comes from the pure state machine (`fromStatesFor`). The check and the write are one atomic statement: of two concurrent identical actions, exactly one succeeds and the other gets `409`. Push-back is the exception: it locks the ticket row first (`FOR UPDATE`) because its new position depends on reading the rows around it.

**Proof** (`packages/db/src/queue.test.ts`, SPEC §12.1): 20 concurrent `callNext` against 10 waiting tickets, on a pool large enough that they really run in parallel, produce exactly 10 distinct called tickets, 10 empty results and no errors.

## Consequences

- Easier: no retries, no distributed locks, no blocking. Adding API replicas doesn't change the guarantee.
- Harder: correctness depends on the database and must stay in SQL; an ORM rewrite of this query must keep `SKIP LOCKED`. The concurrency test guards it.
- `SKIP LOCKED` would also skip a row locked by an unrelated long transaction (for example, a slow push-back on the first ticket). Those transactions are short, so the effect is at most a momentary reordering.
- Revisit if queue ordering ever needs strict fairness across concurrent callers (for example, "the barber who clicked first gets the first customer"); that would need an explicit sequence, not row locks.
