# Fila — project guide for Claude Code

**Fila** ("queue" in Portuguese) is a multi-tenant virtual queue system for small businesses — barbershops, dental clinics, pet shops, auto repair shops. A customer scans a QR code at the counter, joins a live queue from their phone, sees their position and estimated wait update in real time, and gets a push notification when it's their turn. The owner runs the queue from a dashboard and sees metrics (peak hours, average wait, lost customers).

This is a **portfolio project** aimed at remote, international engineering roles. Every technical decision must be explainable in an interview. **Quality and clarity beat feature count.**

## Source of truth

- `docs/SPEC.md` — product and architecture spec. Read the relevant section before starting any task.
- `docs/ROADMAP.md` — phased plan with checkboxes. Work **one phase at a time**. Tick items only when they're done *and* tested.
- `docs/adr/` — Architecture Decision Records. Any non-obvious technical choice gets an ADR (template and required list in SPEC §15).

If the spec and the code disagree, stop and ask. Don't silently diverge. If you think the spec is wrong, say so and propose a change to SPEC.md.

## Stack

| Layer | Choice |
|---|---|
| Monorepo | pnpm workspaces (+ Turborepo for task running) |
| Frontend | Next.js (App Router) + TypeScript + Tailwind CSS |
| API | Fastify + TypeScript |
| Validation | zod (schemas shared between web and api) |
| Database | PostgreSQL 16+ with Row-Level Security |
| ORM / migrations | Drizzle ORM + drizzle-kit; RLS policies in hand-written SQL migrations |
| Real-time | Server-Sent Events (SSE) + Redis pub/sub for fan-out across API replicas |
| Background jobs | BullMQ (on Redis): notifications, auto no-show |
| Notifications | Web Push (VAPID, `web-push` lib) + email (Resend in prod, Mailpit locally) |
| Charts | Recharts |
| Tests | Vitest, Testcontainers (real Postgres + Redis), Playwright (e2e) |
| Lint/format | Biome |
| Deploy | Docker images → GHCR; Kubernetes manifests (Kustomize) in `deploy/k8s`; docker compose for local dev |
| CI | GitHub Actions |

Use the latest stable versions. Check each library's current docs before writing setup code. Don't rely on memory for config APIs.

## Repo layout

```
fila/
├── apps/
│   ├── web/          # Next.js: customer pages (/q/...) + admin dashboard (/admin/...)
│   └── api/          # Fastify: REST + SSE + BullMQ workers (separate entrypoint)
├── packages/
│   ├── db/           # Drizzle schema, migrations (incl. RLS SQL), seed, withTenant()
│   └── shared/       # zod schemas, shared types, queue domain logic (pure functions)
├── deploy/
│   ├── docker/       # Dockerfiles
│   └── k8s/          # Kustomize base + overlays (local, prod)
├── docs/
│   ├── SPEC.md
│   ├── ROADMAP.md
│   └── adr/
├── docker-compose.yml
├── .env.example
└── README.md         # English, recruiter-facing (see SPEC §15)
```

## Commands

> Keep this section accurate. Update it whenever a script is added or changed.

```bash
docker compose up -d        # Postgres, Redis, Mailpit
pnpm install
pnpm db:migrate             # run migrations
pnpm db:seed                # demo tenant + 30 days of history
pnpm dev                    # web + api + worker in watch mode
pnpm test                   # unit + integration (needs Docker for Testcontainers)
pnpm test:e2e               # Playwright
pnpm lint && pnpm typecheck
```

## Conventions

- **English everywhere**: code, comments, commits, docs, default UI copy. Brazilian Portuguese is a translation (i18n), not the source.
- TypeScript `strict`. No `any` without a comment saying why.
- Validate every input at the edge with zod. Schemas live in `packages/shared`.
- **Tenant isolation is non-negotiable.** All access to tenant-scoped tables goes through `withTenant(tenantId, async (tx) => ...)`, which opens a transaction and runs `SET LOCAL app.tenant_id = ...`. Never query tenant tables outside it. The app connects as a non-owner role, and tables use `FORCE ROW LEVEL SECURITY` (SPEC §9).
- Queue domain rules (state transitions, ETA math, ordering) are **pure functions** in `packages/shared/queue`, unit-tested without a DB.
- Timestamps are `timestamptz` stored in UTC. Convert to the tenant's timezone only for display and for aggregation (daily numbering, metrics).
- Errors: typed domain errors, mapped to `application/problem+json` in one Fastify error handler.
- Logging: pino structured logs. Include `tenantId`, `queueId`, `requestId`. Never log tokens or contact info.
- Commits: Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`). Small, one concern each.
- Tests ship with the feature, not later. The concurrency and RLS tests in SPEC §12 are mandatory.
- No secrets in the repo. Every variable is listed in `.env.example` with a comment.

## Working agreement

1. At the start of a phase: summarize the plan and list the files you'll create or change. Wait for approval.
2. During the phase: keep changes inside the phase's scope. Ask before adding any dependency not listed above.
3. At the end of a phase: run lint, typecheck and tests. Update ROADMAP checkboxes and the Commands section. Write any ADRs the phase required. Propose commit message(s).
4. If something takes noticeably longer than expected or needs a design change, stop and explain the options before continuing.
