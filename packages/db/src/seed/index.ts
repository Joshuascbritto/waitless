/** `@waitless/db/seed`: demo data, kept out of the main entry point the API loads. */
export {
  DEMO_HISTORY_DAYS,
  DEMO_TENANTS,
  DEMO_USERS,
  DemoAlreadySeededError,
  type SeedDemoOptions,
  type SeedDemoResult,
  seedDemo,
} from "./demo.ts";
export { CANCEL_RATE, NO_SHOW_RATE, simulateHistory } from "./generate.ts";
