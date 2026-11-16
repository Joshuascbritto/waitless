import { defineConfig } from "drizzle-kit";

// Only `drizzle-kit generate` uses this file; it doesn't connect to a database.
// Migrations are applied by `pnpm db:migrate` (src/migrate.ts) as waitless_owner.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
});
