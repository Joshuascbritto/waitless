# 0001. Multi-tenancy with Postgres Row-Level Security
Date: 2026-11-16
Status: Accepted

## Context

Waitless serves many businesses (tenants) from one deployment. A barbershop must never see a pet shop's customers, queues or metrics. Tenant data includes personal data (names, emails, push subscriptions), so a leak is a privacy incident, not just a bug.

Expected scale is thousands of small tenants with modest data each, on one Postgres instance. The team is one developer, so isolation can't depend on every query being written perfectly.

## Options considered

1. **Application-level filtering** (`WHERE tenant_id = ?` in every query)
   - Pros: simplest, no database features needed, works with any ORM.
   - Cons: one forgotten `WHERE` leaks data across tenants. Nothing catches the mistake at runtime; only code review and tests can.
2. **Schema per tenant** (or database per tenant)
   - Pros: strong isolation; per-tenant backup and restore.
   - Cons: migrations run N times; connection pools and catalogs grow with N; cross-tenant maintenance (metrics, cleanup jobs) gets awkward. Heavy for thousands of tiny tenants.
3. **Shared tables + Row-Level Security**
   - Pros: the database enforces isolation on every query, including ones written by mistake. One schema, one migration path.
   - Cons: needs discipline about connection roles and transaction-scoped settings; policies are SQL the ORM doesn't manage; some performance cost on every row check.

## Decision

Option 3: shared tables, with RLS enabled **and forced** on every tenant-scoped table.

- Two roles. `waitless_owner` owns the tables and runs migrations. `waitless_app` is what the API and worker use: no `BYPASSRLS`, owns nothing. Roles are created by a superuser bootstrap script, not by migrations, because the owner can't create itself.
- `FORCE ROW LEVEL SECURITY` applies policies to the owner too, so even a misconfigured connection doesn't see everything.
- The tenant is set per transaction with `set_config('app.tenant_id', $1, true)`. The `true` makes it transaction-local, so it reverts at commit and can't leak to the next request that reuses the pooled connection. All access goes through `withTenant(tenantId, fn)`.
- Policies read the setting through `app_current_tenant_id()`, which wraps it in `nullif(..., '')`. On a connection where an earlier transaction used the setting, the value is `''`, not NULL, and a bare `''::uuid` cast would raise an error instead of returning zero rows.
- **Fail closed**: with no tenant set, every policy matches zero rows.
- `memberships` is read before any tenant context exists (to check membership, and to list a user's businesses), so it has a dual-key policy: visible by tenant **or** by `app.user_id`; writes always need the tenant.
- Child tables reference parents with composite foreign keys `(tenant_id, parent_id)`. Foreign key checks bypass RLS, so this stops a row of tenant A from pointing at a parent of tenant B.
- Cross-tenant maintenance (seed, PII cleanup) loops over tenants with `withTenant`. No role bypasses RLS.

The mandatory test (`packages/db/src/rls.test.ts`) runs as `waitless_app` against a real Postgres 18 and proves: other tenants' rows are invisible and can't be updated or deleted; inserts for another tenant are rejected; with no tenant set, zero rows; the setting doesn't leak between transactions on one pooled connection; the owner is filtered too.

## Consequences

- Easier: a forgotten filter returns nothing instead of leaking. Security reviews focus on one function (`withTenant`) and one migration file.
- Harder: RLS policies live in hand-written SQL outside the Drizzle schema, so new tables need a policy added on purpose (the RLS test should grow with them). Debugging "why zero rows?" means checking the session setting first.
- Global tables (`tenants`, `users`, `sessions`) are deliberately not tenant-scoped and need application-level care.
- Revisit if a single tenant grows large enough to need its own database, or if policy checks show up in query plans as a bottleneck; partitioning `ticket_events` by month would come first.
