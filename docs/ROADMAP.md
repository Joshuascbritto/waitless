# Waitless — Roadmap

Work one phase at a time. A box is ticked only when the code is merged and its tests pass.
Each phase ends with: lint + typecheck + tests green, ROADMAP and CLAUDE.md "Commands" updated, ADRs written, commit(s).

---

## Phase 0 — Foundation
- [x] SPEC review fixes (memberships RLS, role bootstrap, cross-tenant jobs, `removed` status, ordering tie-break, notification dedupe, join rate limits)
- [x] pnpm workspace + Turborepo: `apps/web`, `apps/api`, `packages/db`, `packages/shared`
- [x] TypeScript strict base config shared by all packages
- [x] Biome config; `pnpm lint`, `pnpm typecheck` at root
- [x] `docker-compose.yml`: postgres, redis, mailpit (with healthchecks)
- [x] `.env.example` with every variable documented
- [x] Fastify app skeleton: pino logging, requestId, helmet, problem+json error handler, `/api/health/live` and `/api/health/ready`
- [x] Next.js app skeleton with Tailwind; dev rewrite `/api/*` → API
- [x] Vitest set up in every package; one trivial passing test each
- [x] GitHub Actions `ci.yml`: install, lint, typecheck, test
- [x] README stub (title, one-liner, "work in progress")

## Phase 1 — Data model, tenancy and auth
- [x] Drizzle schema for all tables in SPEC §5; first migration
- [x] Superuser bootstrap script creating roles `waitless_owner` / `waitless_app` (compose `initdb.d`), outside the migrations
- [x] SQL migration: `ENABLE` + `FORCE ROW LEVEL SECURITY`, policies on every tenant-scoped table, dual-key policy on `memberships`
- [x] `withTenant(tenantId, fn)` with `set_config(..., true)` and `afterCommit` hooks; `withUser(userId, fn)` for membership reads
- [x] **Test: RLS isolation** (SPEC §12.2)
- [x] Register / login / logout / me; argon2id; hashed session ids; cookie settings; Origin check
- [x] Rate limiting on login (Redis store)
- [x] `POST /api/tenants` (creator becomes owner); membership check middleware for `/api/admin/:tenantSlug/*`
- [x] Web: login/register pages, tenant picker, empty admin layout
- [x] ADR-0001 (RLS), ADR-0006 (sessions), ADR-0007 (same-origin)

## Phase 2 — Queue core (no real-time yet)
- [x] `packages/shared/queue`: state machine, `canTransition`, sort-key push-back, position, display code, ETA → **all unit-tested**
- [x] Atomic daily numbering (SPEC §6.2) + **test: 50 parallel joins**
- [x] Public endpoints: queue info, join, view ticket, leave
- [x] Admin endpoints: board, call-next (SKIP LOCKED), call specific, start, finish, push-back, no-show, remove, walk-in
- [x] Every transition writes a `ticket_events` row
- [x] **Test: concurrent call-next** (SPEC §12.1)
- [x] Queue settings CRUD
- [x] Web customer pages: `/q/[tenant]/[queue]` (join form), `/q/[tenant]/t/[token]` (ticket view, polling every 5 s for now)
- [x] Web admin: queue board with all actions, walk-in form, settings page
- [x] OpenAPI + Swagger UI at `/api/docs`
- [x] ADR-0003 (SKIP LOCKED)

## Phase 3 — Real-time
- [x] SSE plugin: headers, heartbeat, cleanup, connection gauge (in-memory; exported to Prometheus in Phase 6)
- [x] Redis pub/sub manager: ref-counted subscription per queue per instance
- [x] Publish after commit on every state change (ids only)
- [x] Admin board stream (full board on connect and on every change; see ADR-0002)
- [x] Customer ticket stream (personalized, redacted payload)
- [x] Replace polling in web with `EventSource` + auto-reconnect UI ("reconnecting…" badge)
- [x] docker compose `full` profile with 2 API replicas behind Caddy
- [x] **Test: cross-instance fan-out** (SPEC §12.4)
- [x] ADR-0002 (SSE), ADR-0004 (Redis fan-out)

## Phase 4 — Notifications and jobs
- [x] BullMQ setup; worker entrypoint `apps/api/src/worker.ts`
- [x] VAPID keys script (`pnpm vapid:generate`); service worker; subscribe flow on the ticket page
- [x] `send-push` job: "almost up" and "your turn", dedupe, retries, 410 cleanup
- [x] `auto-no-show` delayed job + **test: stale job is a no-op**
- [x] PII cleanup job (30 days)
- [x] Minimal PWA `manifest.json` + iOS note in the UI
- [x] Rate limit on join; one-active-ticket-per-device
- [x] ADR-0005 (Web Push vs WhatsApp/SMS)

## Phase 5 — Metrics and QR
- [x] Metrics SQL (SPEC §10) with timezone handling + integration tests with fixed fixtures
- [x] Metrics page: KPI tiles, peak-hours heatmap, daily throughput chart, range selector
- [x] QR poster page (A4, print CSS) per queue
- [x] Seed script with 30 days of realistic history + "live" waiting tickets (SPEC §13)

## Phase 6 — Deploy
- [x] Multi-stage Dockerfiles (web, api), non-root (done early, in Phase 3, for the compose `full` profile)
- [ ] Kustomize base + overlays (local kind/k3d, prod)
- [ ] Migration Job; probes; resources; PDB; Ingress with SSE-friendly settings
- [ ] CronJobs: demo reset, PII cleanup
- [ ] `release.yml`: build → push to GHCR → deploy
- [ ] Prometheus `/api/metrics`
- [ ] Public demo URL live with HTTPS

## Phase 7 — Portfolio polish
- [ ] Playwright e2e (two contexts) in CI
- [ ] README complete (SPEC §15), Mermaid diagram, GIF, demo credentials
- [ ] All ADRs reviewed and linked from the README
- [ ] Lighthouse pass on customer pages (mobile): fast and accessible
- [ ] Repo hygiene: LICENSE (MIT), issue templates, topics/tags on GitHub, pinned on profile
- [ ] Project card on joshuastrauch.com.br

## v1.1 (only after Phase 7)
- [ ] Team invites by email
- [ ] Email notifications (Resend) behind the `Notifier` interface
- [ ] pt-BR translation (next-intl)
- [ ] Sound alert on the admin board when a customer joins
