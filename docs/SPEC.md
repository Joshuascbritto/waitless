# Waitless — Product & Technical Specification

## 1. Problem and pitch

Small businesses in Brazil (barbershops, clinics, pet shops, repair shops) still manage walk-in queues on paper or through chaotic WhatsApp threads. Customers don't know when they'll be seen, so they leave. Owners waste time writing names down and have no data about their busiest hours.

**30-second pitch (use in the README and in interviews):**
> "I built Waitless, a virtual queue for small businesses. In Brazil most barbershops and clinics still run their waiting line on paper. With Waitless, a customer scans a QR code, joins the line from their phone, watches their position update live and gets a push notification when it's their turn — so they can wait at the café next door instead of in the shop. The owner gets a real-time dashboard and metrics like peak hours and abandonment rate. It's multi-tenant with Postgres row-level security, uses SSE with Redis pub/sub for real-time fan-out across replicas, and handles concurrent 'call next' clicks safely with `SKIP LOCKED`."

## 2. Users and core flows

**Customer (anonymous, on a phone)**
1. Scans the QR code → `/q/{tenantSlug}/{queueSlug}`.
2. Sees the queue: people waiting and estimated wait. Enters a name and, optionally, an email. Taps "Join".
3. Gets a ticket page `/q/{tenantSlug}/t/{ticketToken}` with ticket number (e.g. `A-023`), live position, ETA and a "Leave queue" button.
4. Is asked to allow notifications (Web Push). Gets notified when they're next (configurable: "you're 2nd in line") and when they're called.
5. The page keeps working after closing and reopening the browser (token stored in localStorage plus the URL).

**Staff / owner (authenticated)**
1. Logs in → picks a tenant (a user may belong to several) → `/admin/{tenantSlug}`.
2. **Queue board**: live list of waiting/called/serving tickets. Actions: *Call next*, *Call specific*, *Start serving*, *Done*, *Push back* (customer called but not here yet: move behind the next N), *No-show*, *Remove*.
3. **Add walk-in manually** (customer without a phone).
4. **Queue settings**: name, prefix letter, active servers (chairs/counters), default service minutes, "notify when N ahead", auto no-show minutes, open/closed toggle.
5. **QR page**: printable A4 poster with the QR code and short instructions.
6. **Metrics**: peak-hours heatmap, average wait, average service time, abandonment rate, daily throughput.
7. **Team**: invite staff by email (owner only).

**Multi-store**: one platform, many tenants (businesses). Each tenant has its own dashboard, queues, staff and data, fully isolated.

## 3. Scope

**MVP (must have)**: everything in §2 except team invites, i18n and email notifications. Web Push is enough for the MVP. Until invites ship, staff accounts exist only through the seed.

**v1.1 (nice to have)**: team invites, email notifications, pt-BR translation, "pause queue" message, staff-side sound alert.

**Not doing (say so in the README "Future work")**: WhatsApp/SMS (official WhatsApp Business API needs an approved business account; unofficial gateways break WhatsApp's terms), payments, appointment booking with time slots, native mobile apps.

## 4. Architecture

```
 Customer phone            Owner laptop
      │  HTTPS                  │
      ▼                         ▼
 ┌──────────────── Ingress / reverse proxy ────────────────┐
 │   /            → web (Next.js)                          │
 │   /api/*       → api (Fastify)   ← SSE streams here     │
 └─────────────────────────────────────────────────────────┘
          │                    │ (2+ replicas)
          │                    ├──► PostgreSQL (RLS)
          │                    ├──► Redis: pub/sub channel per queue
          │                    └──► Redis: BullMQ queues
          │
     worker (same image as api, different entrypoint)
          └──► BullMQ: send-push, send-email, auto-no-show
```

- Web and API are served from the **same origin** (`/api` routed by ingress in prod, Next.js rewrites in dev). This avoids CORS and cross-site cookie problems.
- **Dev gotcha**: Next.js rewrites may buffer SSE. If streams arrive in chunks in dev, point `EventSource` directly at the API origin in development only (CORS with credentials for that origin) and document it.
- The API is stateless. Any replica can serve any request or stream. That's why Redis pub/sub exists (§7).
- Run **2 API replicas** in docker compose and k8s from early on, so the fan-out design is actually exercised.

## 5. Data model

All tenant-scoped tables have `tenant_id uuid not null` and RLS enabled. Use `uuid` PKs generated with PostgreSQL 18's native `uuidv7()` (time-ordered, so they also work as a stable tie-breaker). Child tables reference their parent with a composite foreign key `(tenant_id, parent_id)`: foreign key checks bypass RLS, so a plain `queue_id` reference would let a row of tenant A point at a queue of tenant B.

```sql
tenants (                      -- NOT RLS-scoped (resolved by slug before tenant context exists)
  id uuid pk, name text, slug text unique, timezone text default 'America/Bahia',
  created_at timestamptz
)

users (                        -- NOT tenant-scoped
  id uuid pk, email citext unique, name text, password_hash text, created_at
)

memberships (                  -- RLS, dual-key policy: visible by tenant OR by user (see §9)
  tenant_id uuid fk, user_id uuid fk, role text check (role in ('owner','staff')),
  primary key (tenant_id, user_id)
)

sessions (                     -- NOT tenant-scoped
  id text pk,                  -- sha256 (hex) of a random 256-bit token; the token only lives in the cookie
  user_id uuid fk, expires_at timestamptz, created_at
)

queues (                       -- RLS
  id uuid pk, tenant_id uuid fk, name text, slug text, prefix char(1) default 'A',
  is_open boolean default true,
  active_servers int default 1 check (active_servers > 0),
  default_service_minutes int default 15,
  notify_when_ahead int default 2,
  no_show_after_minutes int default 5,
  unique (tenant_id, slug)
)

queue_counters (               -- RLS; daily ticket numbering
  tenant_id uuid, queue_id uuid fk, day date, last_number int,
  primary key (queue_id, day)
)

tickets (                      -- RLS
  id uuid pk, tenant_id uuid fk, queue_id uuid fk,
  public_token text unique,    -- random 128-bit, base64url; the customer's capability
  number int, display_code text,     -- e.g. 'A-023'
  customer_name text, customer_email text null,
  source text check (source in ('qr','walk_in')),
  status text check (status in ('waiting','called','serving','done','no_show','cancelled','removed')),
  sort_key numeric not null,   -- ordering among waiting tickets (see §6.3)
  device_id text null,         -- anonymous device cookie; enforces one active ticket per device per queue
  joined_at, called_at, serving_at, finished_at timestamptz,
                               -- called_at is the LATEST call; the first call lives in ticket_events
  called_by uuid null fk users,
  push_count int default 0     -- times pushed back
)
-- index: (queue_id, status, sort_key)
-- partial index: (queue_id, sort_key) where status = 'waiting'

push_subscriptions (           -- RLS
  id uuid pk, tenant_id, ticket_id fk on delete cascade,
  endpoint text, p256dh text, auth text, created_at
)

ticket_events (                -- RLS; append-only audit log, feeds metrics & debugging
  id bigserial pk, tenant_id, ticket_id, queue_id,
  type text,                   -- joined, called, pushed_back, serving, done, no_show, cancelled, removed, notified
  actor_type text check (actor_type in ('customer','staff','system')),
  actor_id uuid null, payload jsonb, at timestamptz default now()
)
-- unique partial index: (ticket_id, (payload->>'kind')) where type = 'notified'   -- notification dedupe (§8)
```

**Contact info is personal data.** Push subscriptions are deleted as soon as the ticket reaches a final status (they have no further use). `customer_email` is deleted 30 days after a ticket finishes (a scheduled BullMQ job). Mention this in the README (LGPD/GDPR awareness is a good interview signal).

## 6. Queue logic

All rules below live as pure functions in `packages/shared/queue` with unit tests. DB code calls them; it doesn't re-implement them.

### 6.1 State machine

```
waiting ──call──► called ──start──► serving ──finish──► done
   │                 │  └──push_back(n)──► waiting
   │                 └──no_show (staff or auto after N min)──► no_show
   ├──cancel (customer)──► cancelled
   └──remove (staff)──► removed
```

`cancelled` (the customer left) and `removed` (staff cleanup, e.g. a duplicate or a mistake) are separate final states, so staff corrections don't inflate the abandonment rate (§10). `cancel` and `remove` are also allowed from `called`.

Any other transition is rejected with `409 Conflict` (`InvalidTransitionError`). Export `canTransition(from, action)` and test it exhaustively (table-driven).

### 6.2 Ticket numbering

Numbers reset daily, per queue, in the tenant's timezone. Allocate atomically:

```sql
INSERT INTO queue_counters (tenant_id, queue_id, day, last_number)
VALUES ($tenant, $queue, (now() AT TIME ZONE $tz)::date, 1)
ON CONFLICT (queue_id, day) DO UPDATE SET last_number = queue_counters.last_number + 1
RETURNING last_number;
```

`display_code = prefix || '-' || lpad(number, 3, '0')`.

### 6.3 Ordering and "push back"

- New ticket: `sort_key = extract(epoch from now()) * 1000`.
- **Total order is `(sort_key, id)`.** Two joins in the same millisecond get equal keys; the uuidv7 `id` breaks the tie deterministically. Every `ORDER BY` and position count uses this pair.
- Push back by N (default 2): take the waiting tickets in that order. Set this ticket's `sort_key` to the midpoint between the Nth and (N+1)th keys. If fewer than N+1 are waiting, put it at the end (`max + 1`). Status goes back to `waiting`, `push_count += 1`.
- Position = `1 + count(waiting tickets in the same queue where (sort_key, id) < (my sort_key, my id))`.

### 6.4 Call next — concurrency-safe

Two staff members can click "Call next" at the same moment. Both must get **different** tickets, and neither request may fail or block:

```sql
UPDATE tickets t SET status = 'called', called_at = now(), called_by = $user
WHERE t.id = (
  SELECT id FROM tickets
  WHERE queue_id = $queue AND status = 'waiting'
  ORDER BY sort_key, id
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

Returns 0 rows → `204` "queue empty". Mandatory test: 20 parallel `callNext` against 10 waiting tickets → exactly 10 distinct tickets called, 10 empty responses, no errors. This is the main interview talking point. Write ADR-0003 about it.

### 6.5 Estimated wait (ETA)

- `avgService` = exponentially weighted moving average (α = 0.3) of `finished_at - serving_at` over the queue's last 20 completed tickets **today**. Fallback: `queue.default_service_minutes`.
- `etaMinutes(position) = ceil(((position - 1) / active_servers) * avgService)`, plus the remaining time of tickets currently being served (estimate: `max(0, avgService - elapsed)` averaged over servers). Keep it simple and documented.
- Show a **range**, not a false-precision number: `~15–20 min` (round to 5-minute buckets, ±20%). Position 1 shows "You're next".
- Pure function, unit-tested with fixed inputs.

### 6.6 Auto no-show

When a ticket is called, enqueue a BullMQ **delayed job** `auto-no-show` with delay `no_show_after_minutes`, job id `no-show-{ticketId}-{calledAtEpochMs}` (no `:` in custom job ids: BullMQ uses it as its Redis key separator). The job payload carries `tenantId` so the worker can enter `withTenant`. The job re-reads the ticket. It only acts if it's still `called` with the same `called_at`, so a push-back followed by a re-call doesn't trigger a stale job. Idempotent by design.

## 7. Real-time (SSE + Redis pub/sub)

**Why SSE, not WebSocket** (ADR-0002): updates only flow server → client. Client actions are normal REST calls. SSE runs over plain HTTP, reconnects automatically, supports `Last-Event-ID`, passes through proxies and ingress without upgrade config, and is trivial to authenticate with the existing cookie.

**Streams**
- `GET /api/admin/:tenantSlug/queues/:queueId/stream` (session cookie): sends a `board` event with the **whole board** on connect and after every change. (Originally planned as incremental `ticket.updated` / `ticket.created` events; the refresh query already yields the full board, it is small, and the browser never has to merge partial updates. See ADR-0002.)
- `GET /api/public/q/:tenantSlug/t/:token/stream` (no auth; the token is the capability): sends a `ticket` event with the same payload as the ticket GET (`status, position, etaRange, displayCode, nowServing` plus tenant and queue names). **Never** send other customers' names or tokens.

**Fan-out**
- On every state change, after the DB transaction commits, publish to Redis channel `waitless:queue:{queueId}` with payload `{ type, tenantId, queueId, ticketId }` (ids only, no PII). No version number: subscribers always re-read the current state. `tenantId` lets the receiving instance run its refresh query inside `withTenant`.
- Each API instance keeps **one** Redis subscription per queue that has at least one connected client (reference-counted; unsubscribe when the last client disconnects).
- On a message, the instance runs **one** query to fetch the current ordered waiting list for that queue, then computes and pushes each connected client's personalized payload in memory. Cost is one query per event per instance, not one per client. While a refresh runs, further events only mark the queue dirty and trigger one follow-up refresh.
- Heartbeat comment (`: ping`) every 15 s. Headers: `Cache-Control: no-cache`, `X-Accel-Buffering: no`. Clean up on `close`.
- On reconnect, the client always gets a fresh `snapshot` (simpler than event replay; document this).

**Publish after commit**: publishing inside the transaction could announce state that then rolls back. Use a small helper `afterCommit(fn)` collected by `withTenant`.

## 8. Notifications

- Web Push via VAPID keys (`.env`: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`). The service worker lives in `apps/web/public/sw.js`.
- Triggers (enqueued as BullMQ `send-push` jobs, retried with exponential backoff, max 3 attempts):
  - Position becomes ≤ `notify_when_ahead` → "You're almost up at {tenant} — {n} ahead of you".
  - Ticket is called → "It's your turn! Ticket A-023".
- **Who detects "almost up"**: any state change can move many tickets forward at once. After commit, the API that made the change enqueues one `notify-scan` job for the queue (`{ tenantId, queueId }`). The worker reads the ordered waiting list once and enqueues `send-push` for every ticket at or under the threshold. Only one place runs this check, so the API replicas don't each send their own copy.
- **Dedupe, two layers**: (1) `send-push` uses job id `push-{ticketId}-{kind}`, so BullMQ ignores a duplicate enqueue while the first job is retained; (2) after a successful send the worker inserts a `ticket_events` row (`type = 'notified', payload.kind`), and the unique partial index (§5) rejects a second one. The worker checks for that row before sending.
- `410 Gone` from the push service → delete that subscription.
- Email (v1.1): same triggers, through Resend in prod and Mailpit in dev, behind a `Notifier` interface so the job doesn't care about the channel.
- iOS note for the README: Web Push on iPhone works only if the site is added to the home screen (PWA). Add a minimal `manifest.json` and say so honestly.

## 9. Multi-tenancy and security

**Row-Level Security** (ADR-0001):

```sql
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tickets
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
```

`app_current_tenant_id()` is `nullif(current_setting('app.tenant_id', true), '')::uuid`. On a pooled connection where an earlier transaction set the value, `current_setting` returns `''` rather than NULL, and a bare `''::uuid` cast would raise an error instead of matching zero rows.

- Two DB roles: `waitless_owner` (owns tables, runs migrations) and `waitless_app` (what the API and worker use, no `BYPASSRLS`). Because of `FORCE`, even the owner is filtered when it queries.
- **Roles are created outside the migrations**, by a superuser bootstrap script (`deploy/docker/postgres/init/*.sql` mounted into the Postgres container's `docker-entrypoint-initdb.d`, and a one-off superuser Job in k8s). Migrations run as `waitless_owner`, which can't create roles, including itself.
- `withTenant(tenantId, fn)`: `BEGIN; SELECT set_config('app.tenant_id', $1, true); ... COMMIT`. With no tenant set, `current_setting(..., true)` returns NULL → zero rows. **Fail closed.**
- `withUser(userId, fn)`: same pattern with `app.user_id`. Used only to read the caller's own `memberships`.
- **`memberships` policy is dual-key**, because it's read before any tenant context exists (the membership check, `/api/auth/me`):
  ```sql
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid
         OR user_id = current_setting('app.user_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)
  ```
  Reads are allowed by tenant (team page) or by user (my memberships). Writes always need tenant context. With neither set, it still returns zero rows.
- Admin requests: the tenant comes from the URL slug; membership is checked with `withUser(sessionUserId)` **before** entering `withTenant`.
- `POST /api/tenants`: insert into `tenants` (not RLS-scoped), then insert the owner membership inside `withTenant(newTenantId)`.
- Public requests: resolve tenant by slug (tenants table, not RLS-scoped), then `withTenant`, then look up the ticket by `public_token`.
- **Cross-tenant maintenance** (seed, demo reset, PII cleanup): list tenants from the unscoped `tenants` table, then process each one inside its own `withTenant`. No role bypasses RLS. Every BullMQ job payload carries `tenantId`.

**Auth**
- Email + password, hashed with argon2id. Session id is random 256-bit, stored hashed. Cookie: `__Host-waitless_session; HttpOnly; Secure; SameSite=Lax; Path=/`. 14-day sliding expiry, renewed only when less than half remains (ADR-0006).
- CSRF: SameSite=Lax plus an `Origin` header check on state-changing requests.
- Rate limits (`@fastify/rate-limit` backed by Redis): login 5/min per IP+email; join queue 3/10 min per device per queue plus 30/10 min per IP per queue as a backstop; public stream connections capped per IP. The per-IP limits are loose on purpose: Brazilian mobile carriers use CGNAT and a shop's Wi-Fi is one IP, so many real customers share an address.
- **Device id**: an anonymous random cookie `waitless_device` (HttpOnly, 1 year), set on the first public request.
- One active ticket per device per queue: if this device already has an active ticket in this queue (server-side, by `device_id`), return it instead of creating another. The client also keeps the token in localStorage. This is a UX guard against double taps, not a security control; clearing cookies bypasses it, and that's acceptable.
- Security headers via `@fastify/helmet`. `public_token` is never logged.

## 10. Metrics

Computed from `tickets` (plus `ticket_events` where needed), in the tenant's timezone, for ranges 7 / 30 / 90 days:

| Metric | Definition |
|---|---|
| Avg wait | mean(first `called` event `at` − `joined_at`). The first call comes from `ticket_events`, because `tickets.called_at` is overwritten on a re-call |
| Avg service | mean(`finished_at - serving_at`) for `done` |
| Abandonment rate | (`cancelled` + `no_show`) / tickets in a final status, excluding `removed` |
| Throughput | `done` tickets per day |
| Peak hours | heatmap: count of `joined_at` by weekday × hour (`AT TIME ZONE tz`) |
| p90 wait | `percentile_cont(0.9)` of wait |

Plain SQL with proper indexes is enough at this scale. **Don't** add materialized views unless a measured query is slow. If you do, write an ADR with the before/after numbers.

## 11. API (REST, JSON, problem+json errors)

```
POST   /api/auth/register | /api/auth/login | /api/auth/logout
GET    /api/auth/me                                   → user + memberships

GET    /api/public/q/:tenantSlug/:queueSlug            → queue info (name, isOpen, waitingCount, etaRange)
POST   /api/public/q/:tenantSlug/:queueSlug/tickets    → join {name, email?} → {token, displayCode}
GET    /api/public/q/:tenantSlug/t/:token              → ticket view
DELETE /api/public/q/:tenantSlug/t/:token              → leave queue
POST   /api/public/q/:tenantSlug/t/:token/push         → save push subscription
GET    /api/public/q/:tenantSlug/t/:token/stream       → SSE

GET    /api/admin/:tenantSlug/queues                   (+ POST, PATCH /:queueId)
GET    /api/admin/:tenantSlug/queues/:queueId/board
GET    /api/admin/:tenantSlug/queues/:queueId/stream   → SSE
POST   /api/admin/:tenantSlug/queues/:queueId/call-next
POST   /api/admin/:tenantSlug/tickets/:id/{call|start|finish|push-back|no-show|remove}   (remove → status `removed`)
POST   /api/admin/:tenantSlug/queues/:queueId/walk-ins
GET    /api/admin/:tenantSlug/metrics?range=7d&queueId=
POST   /api/tenants                                    → create tenant (caller becomes owner)
```

Generate an OpenAPI document from the zod schemas (`fastify-type-provider-zod` or similar) and serve Swagger UI at `/api/docs` in dev and in the demo.

## 12. Testing strategy

- **Unit (Vitest)**: state machine (every from × action pair), ETA math, sort-key push-back, display code, payload redaction.
- **Integration (Vitest + Testcontainers Postgres/Redis)**, all mandatory:
  1. **Concurrency**: 20 parallel `callNext` vs 10 waiting → 10 distinct called, 10 empty, 0 errors.
  2. **RLS isolation**: as `waitless_app` with tenant A set, selecting/updating tenant B's tickets returns 0 rows / affects 0 rows. With no tenant set → 0 rows. `memberships`: with `app.user_id` set, the user sees only their own rows across tenants; inserting a membership without tenant context fails.
  3. **Numbering**: 50 parallel joins → numbers 1..50, no gaps, no duplicates. Day rollover in the tenant timezone.
  4. **Fan-out**: two API instances in one test, client on instance B, action on instance A → client receives the event.
  5. **Auto no-show**: stale job after push-back + re-call does nothing.
- **E2E (Playwright)**: two browser contexts. The customer joins via the QR URL, the admin clicks "Call next", the customer page shows "It's your turn" without reloading.
- CI runs everything on every PR. Coverage report uploaded, but no coverage-percentage gate.

## 13. Seed and demo

`pnpm db:seed` creates:
- Tenant **"Barbearia Demo"** (fictional), timezone `America/Bahia`, queues "Haircut" (prefix A, 2 servers, 20 min) and "Beard" (prefix B, 1 server, 10 min).
- Second tenant **"PetShop Demo"** (to show multi-tenancy and RLS in the demo).
- Users: `owner@demo.waitless.dev` / `demo1234` (owner of both), `staff@demo.waitless.dev` / `demo1234`.
- **30 days of realistic history**: arrival rates by weekday and hour (busy Friday evenings and Saturday mornings), service times drawn from a normal distribution around the queue default, ~8% cancelled and ~5% no-show. This makes the metrics page look real.
- A few tickets waiting *right now*, so the board isn't empty.
- Public demo: reset the demo data nightly (k8s CronJob running the seed with `--reset-demo`).

## 14. Deployment and CI

- **Dockerfiles**: multi-stage, non-root user, pnpm `deploy` for slim images. Images: `waitless-web`, `waitless-api` (the worker uses the api image with `CMD node dist/worker.js`).
- **docker-compose.yml** (dev): postgres, redis, mailpit. Optional `--profile full` that also runs web + 2× api + worker + Caddy, to test the prod-like routing locally.
- **Kubernetes** (`deploy/k8s`, Kustomize):
  - `base/`: Deployments for web, api (replicas: 2), worker; Services; Ingress (`/api` → api, `/` → web, with SSE-friendly timeouts and buffering off); ConfigMap; Secret templates (no real values); PodDisruptionBudget for api; liveness and readiness probes (`/api/health/live`, `/api/health/ready` checking DB + Redis); resource requests and limits.
  - Role bootstrap: a one-off superuser `Job` that creates `waitless_owner` / `waitless_app` if missing (§9).
  - Migrations: a `Job` (or init container) using the `waitless_owner` credentials.
  - `overlays/local` (kind or k3d) and `overlays/prod` (VPS running k3s + Traefik + cert-manager, or managed Postgres/Redis).
  - CronJobs: demo reset, PII cleanup.
- **GitHub Actions**: `ci.yml` (install → lint → typecheck → unit → integration → e2e → build) on PRs; `release.yml` on `main` builds and pushes images to GHCR tagged with the git SHA, then deploys (kubectl/kustomize with a kubeconfig secret).
- **Observability (light)**: pino JSON logs, `/api/metrics` Prometheus endpoint (`prom-client`) with SSE connection gauge, tickets created counter and call-next latency histogram. Mention in the README; no Grafana stack required.

## 15. README and ADRs

### README.md (English, recruiter-facing) — sections in this order
1. One-line description + **live demo link** + demo credentials.
2. **GIF** (≤ 15 s): phone joins the queue → admin clicks call next → phone updates and buzzes. Side-by-side.
3. "Why" — the problem in 3 sentences (paper queues in Brazil).
4. Features (short bullets).
5. **Architecture diagram** (Mermaid) + 1 paragraph.
6. **Engineering highlights** — 4–5 bullets linking to ADRs and to the exact code/tests: SKIP LOCKED, RLS, SSE + Redis fan-out, ETA estimation, idempotent delayed jobs.
7. Run locally in 3 commands.
8. Tests (what is covered, how to run).
9. Deployment (k8s overview).
10. Future work / non-goals (WhatsApp and why not, booking, payments).

### ADRs to write (`docs/adr/NNNN-title.md`)
- 0001 Multi-tenancy with Postgres Row-Level Security (vs schema-per-tenant vs app-level filtering)
- 0002 SSE over WebSockets for real-time updates
- 0003 Concurrency-safe "call next" with `FOR UPDATE SKIP LOCKED`
- 0004 Redis pub/sub for cross-replica fan-out
- 0005 Web Push instead of WhatsApp/SMS for the MVP
- 0006 Session cookies over JWT
- 0007 Same-origin routing for web and API

**Template**
```markdown
# NNNN. Title
Date: YYYY-MM-DD
Status: Accepted

## Context
What problem, what constraints.

## Options considered
1. Option A — pros / cons
2. Option B — pros / cons

## Decision
What we chose and why.

## Consequences
What gets easier, what gets harder, what we'd revisit and when.
```

## 16. Interview talking points (keep these demonstrable)

- "Two staff click 'call next' at the same time" → SKIP LOCKED + the test that proves it.
- "How do you keep tenants from seeing each other's data?" → RLS + FORCE + fail-closed + the isolation test.
- "How does real-time work with multiple servers?" → SSE + Redis pub/sub, one subscription per queue per instance, one query per event.
- "How do you estimate wait time?" → EWMA, ranges instead of false precision, fallback values.
- "What happens if a notification fails?" → BullMQ retries with backoff, idempotency, 410 cleanup.
- "What would you change at 10,000 stores?" → partition `ticket_events` by month, read replica for metrics, rollups, sticky SSE connections, and managed Redis with replication.
