import pg from "pg";

export {
  type AfterCommit,
  type CreateDbOptions,
  createDb,
  type Database,
  type Db,
  type ScopedContext,
  type ScopedFn,
  type Tx,
} from "./client.ts";
export { isUniqueViolation, pgErrorCode } from "./errors.ts";
export { MIGRATIONS_FOLDER, runMigrations } from "./migrate.ts";
export * from "./schema.ts";
export { createTenantWithOwner, type NewTenant, type Tenant } from "./tenants.ts";

/** The minimum a health check needs, so tests can pass a fake instead of a real pool. */
export interface Queryable {
  query(sql: string): Promise<unknown>;
}

/** Connection pool for the API and worker. createDb() wraps it with withTenant()/withUser(). */
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    // Fail fast instead of hanging a request when Postgres is unreachable.
    connectionTimeoutMillis: 2_000,
  });
}

/** Round-trips a trivial query. Used by `/api/health/ready`. */
export async function pingDatabase(db: Queryable): Promise<void> {
  await db.query("select 1");
}

// Query operators, re-exported so consumers share this package's drizzle-orm
// instance instead of resolving their own copy.
export { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
export * from "./maintenance.ts";
export * from "./notifications.ts";
export * from "./queue.ts";
