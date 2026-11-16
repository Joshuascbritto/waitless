import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type pg from "pg";
import * as schema from "./schema.ts";

export type Database = NodePgDatabase<typeof schema>;
/** A Drizzle handle bound to one open transaction. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type AfterCommit = (fn: () => void | Promise<void>) => void;

export interface ScopedContext {
  /**
   * Registers work to run only after the transaction commits, e.g. publishing
   * a real-time event. Publishing inside the transaction could announce state
   * that then rolls back (SPEC §7).
   */
  afterCommit: AfterCommit;
}

export type ScopedFn<T> = (tx: Tx, ctx: ScopedContext) => Promise<T>;

export interface Db {
  /**
   * Runs `fn` in a transaction where RLS sees only `tenantId`'s rows.
   * The only way to touch tenant-scoped tables (CLAUDE.md conventions).
   */
  withTenant<T>(tenantId: string, fn: ScopedFn<T>): Promise<T>;
  /** Same, scoped to a user: reads the caller's own memberships across tenants. */
  withUser<T>(userId: string, fn: ScopedFn<T>): Promise<T>;
  /**
   * No tenant or user context. For the global tables only: tenants, users,
   * sessions. Tenant tables queried through it return zero rows (fail closed).
   */
  global: Database;
}

export interface CreateDbOptions {
  /** afterCommit hooks run after the commit, so their errors can't fail the request. Report them here. */
  onAfterCommitError?: (error: unknown) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createDb(pool: pg.Pool, options: CreateDbOptions = {}): Db {
  const global = drizzle({ client: pool, schema });
  const reportError =
    options.onAfterCommitError ??
    ((error: unknown) => {
      console.error("afterCommit hook failed", error);
    });

  async function scoped<T>(setting: string, value: string, fn: ScopedFn<T>): Promise<T> {
    // Policies cast the setting to uuid; reject anything else before it reaches SQL.
    if (!UUID.test(value)) {
      throw new TypeError(`${setting} must be a UUID`);
    }

    const hooks: Array<() => void | Promise<void>> = [];
    const result = await global.transaction(async (tx) => {
      // `true` = transaction-local (SET LOCAL): reverts on COMMIT/ROLLBACK, so it
      // never leaks to the next request that reuses this pooled connection.
      await tx.execute(sql`select set_config(${setting}, ${value}, true)`);
      return fn(tx, { afterCommit: (hook) => hooks.push(hook) });
    });

    // Only reached when the transaction committed; a throw above skips the hooks.
    for (const hook of hooks) {
      try {
        await hook();
      } catch (error) {
        reportError(error);
      }
    }
    return result;
  }

  return {
    global,
    withTenant: (tenantId, fn) => scoped("app.tenant_id", tenantId, fn),
    withUser: (userId, fn) => scoped("app.user_id", userId, fn),
  };
}
