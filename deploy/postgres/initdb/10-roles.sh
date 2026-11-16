#!/usr/bin/env bash
# Creates the two application roles (SPEC §9). Runs as the Postgres superuser:
#   - docker compose: automatically, from /docker-entrypoint-initdb.d, on an EMPTY volume only
#   - Testcontainers: same mechanism, copied into the test container
#   - Kubernetes (Phase 6): a one-off superuser Job
# Migrations can't do this: they run as waitless_owner, which can't create roles.
# Idempotent, so it is safe to run again.
set -euo pipefail

: "${WAITLESS_OWNER_PASSWORD:?WAITLESS_OWNER_PASSWORD must be set}"
: "${WAITLESS_APP_PASSWORD:?WAITLESS_APP_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER:-postgres}" \
  --dbname "${POSTGRES_DB:-waitless}" \
  -v owner_password="$WAITLESS_OWNER_PASSWORD" \
  -v app_password="$WAITLESS_APP_PASSWORD" <<'SQL'
-- waitless_owner owns the schema and runs migrations.
SELECT format('CREATE ROLE waitless_owner LOGIN PASSWORD %L', :'owner_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'waitless_owner') \gexec

-- waitless_app is what the API and worker use. No BYPASSRLS, owns nothing.
SELECT format('CREATE ROLE waitless_app LOGIN PASSWORD %L NOBYPASSRLS', :'app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'waitless_app') \gexec

SELECT format('ALTER DATABASE %I OWNER TO waitless_owner', current_database()) \gexec
ALTER SCHEMA public OWNER TO waitless_owner;

-- Only the owner may create objects; the app may only use them.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO waitless_app;

-- Every table/sequence the owner creates later (i.e. in migrations) is usable by the app.
-- RLS policies, not grants, decide which rows it sees.
ALTER DEFAULT PRIVILEGES FOR ROLE waitless_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO waitless_app;
ALTER DEFAULT PRIVILEGES FOR ROLE waitless_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO waitless_app;
SQL
