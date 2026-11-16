import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/** packages/db/migrations, resolved from both src/ (dev) and dist/ (built). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Applies pending migrations. Must connect as waitless_owner: the app role
 * can't create tables, and that's the point.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

// `pnpm db:migrate` runs this file directly.
if (import.meta.main) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error("MIGRATION_DATABASE_URL is not set (see .env.example)");
    process.exit(1);
  }
  await runMigrations(url);
  console.log("migrations applied");
}
