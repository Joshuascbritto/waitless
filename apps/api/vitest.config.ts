import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Integration tests start a real Postgres container in beforeAll.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
