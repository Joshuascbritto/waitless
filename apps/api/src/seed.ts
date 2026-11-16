/**
 * Demo data CLI (SPEC §13): `pnpm db:seed` locally, `node dist/seed.js
 * --reset-demo` in the nightly k8s CronJob. It lives in the API because the
 * API owns password hashing, and its image is the one deployed with database
 * access; the data itself comes from @waitless/db/seed.
 *
 * Connects as waitless_app, like the API: the seed goes through RLS too.
 */
import { parseArgs } from "node:util";
import { createDb, createPool } from "@waitless/db";
import { DEMO_USERS, DemoAlreadySeededError, seedDemo } from "@waitless/db/seed";
import { z } from "zod";
import { hashPassword } from "./auth/passwords.ts";

/** Public on purpose: the demo login is printed in the README. */
const DEMO_PASSWORD = "demo1234";

const { values } = parseArgs({ options: { "reset-demo": { type: "boolean", default: false } } });
const env = z.object({ DATABASE_URL: z.url() }).parse(process.env);

const pool = createPool(env.DATABASE_URL);
try {
  const result = await seedDemo(createDb(pool), {
    passwordHash: await hashPassword(DEMO_PASSWORD),
    reset: values["reset-demo"],
  });
  console.log(
    `Seeded ${result.tenants} demo businesses and ${result.tickets} tickets. ` +
      `Log in as ${DEMO_USERS.owner.email} or ${DEMO_USERS.staff.email} / ${DEMO_PASSWORD}`,
  );
} catch (error) {
  if (error instanceof DemoAlreadySeededError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await pool.end();
}
