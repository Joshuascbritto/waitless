/**
 * Test helper: a real PostgreSQL 18 in a container, bootstrapped exactly like
 * docker compose (same init script) and migrated with the real migrations.
 * Exposed as `@waitless/db/testing`; only test files import it.
 */
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { runMigrations } from "./migrate.ts";

const IMAGE = "postgres:18.7-alpine";
const INIT_SCRIPT = fileURLToPath(
  new URL("../../../deploy/docker/postgres/initdb/10-roles.sh", import.meta.url),
);

export interface TestDatabase {
  /** waitless_app: what the API uses. RLS applies. */
  appUrl: string;
  /** waitless_owner: owns the tables. RLS still applies (FORCE). */
  ownerUrl: string;
  stop(): Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(IMAGE)
    .withDatabase("waitless")
    .withUsername("postgres")
    .withPassword("postgres")
    .withEnvironment({ WAITLESS_OWNER_PASSWORD: "owner", WAITLESS_APP_PASSWORD: "app" })
    .withCopyFilesToContainer([
      { source: INIT_SCRIPT, target: "/docker-entrypoint-initdb.d/10-roles.sh", mode: 0o755 },
    ])
    .start();

  const base = `${container.getHost()}:${container.getPort()}/waitless`;
  const ownerUrl = `postgres://waitless_owner:owner@${base}`;
  await runMigrations(ownerUrl);

  return {
    appUrl: `postgres://waitless_app:app@${base}`,
    ownerUrl,
    stop: async () => {
      await container.stop();
    },
  };
}

/**
 * A pool for tests. pool.end() resolves once the pool has let go of its
 * clients, which can be before their sockets finish closing; stopping the
 * container right after makes Postgres send 57P01 (admin shutdown) to a client
 * that no longer has an error listener, and Vitest reports it as unhandled.
 * Only that teardown error is swallowed; anything else is rethrown.
 */
export function createTestPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({ connectionString, max });
  pool.on("connect", (client) => {
    client.on("error", (error: Error & { code?: string }) => {
      if (error.code !== "57P01") throw error;
    });
  });
  return pool;
}
