-- Row-level security (SPEC §9, ADR-0001).
--
-- The API connects as waitless_app, which has no BYPASSRLS. FORCE makes the
-- policies apply to the table owner too, so nobody reads tenant data without
-- a tenant context. Without one, every policy below sees NULL and matches
-- zero rows: the system fails closed.

-- current_setting(..., true) returns NULL when the setting was never defined,
-- but '' (empty string) on a pooled connection where an earlier transaction
-- used set_config(..., true). nullif() turns both into NULL; a bare ''::uuid
-- cast would raise an error instead of returning zero rows.
CREATE FUNCTION app_current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint

-- Tenant-scoped tables: one policy, same rule for reads and writes.
ALTER TABLE queues ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE queues FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON queues
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE queue_counters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE queue_counters FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON queue_counters
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tickets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tickets
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON push_subscriptions
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE ticket_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ticket_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON ticket_events
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint

-- memberships is read before any tenant context exists (the membership check,
-- /api/auth/me), so reads match by tenant OR by the current user. Writes
-- always need the tenant context.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY membership_visibility ON memberships
  USING (tenant_id = app_current_tenant_id() OR user_id = app_current_user_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint

-- ticket_events is an append-only audit log.
REVOKE UPDATE, DELETE ON ticket_events FROM waitless_app;
