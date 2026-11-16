import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against a running stack, by default the prod-like
 * `docker compose --profile full` on :8080 (Caddy, two API replicas, worker),
 * so a customer's stream and the admin's click usually land on different
 * replicas, as in production.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:8080";

export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
