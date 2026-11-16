import pg from "pg";

/** The minimum a health check needs, so tests can pass a fake instead of a real pool. */
export interface Queryable {
  query(sql: string): Promise<unknown>;
}

/**
 * Connection pool for the API and worker. Phase 1 adds Drizzle on top of it
 * and `withTenant()`, which takes a client from this pool per transaction.
 */
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
