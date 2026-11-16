import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { type AppDeps, buildApp } from "./app.ts";

const ok = async () => {};
const down = async () => {
  throw new Error("ECONNREFUSED");
};

let app: FastifyInstance | undefined;

async function build(overrides: Partial<AppDeps> = {}): Promise<FastifyInstance> {
  app = await buildApp({ logger: false, readinessChecks: [], ...overrides });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("GET /api/health/live", () => {
  it("answers 200 even when every dependency is down", async () => {
    const server = await build({ readinessChecks: [{ name: "postgres", check: down }] });

    const res = await server.inject({ method: "GET", url: "/api/health/live" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("GET /api/health/ready", () => {
  it("answers 200 when all checks pass", async () => {
    const server = await build({
      readinessChecks: [
        { name: "postgres", check: ok },
        { name: "redis", check: ok },
      ],
    });

    const res = await server.inject({ method: "GET", url: "/api/health/ready" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", checks: { postgres: "ok", redis: "ok" } });
  });

  it("answers 503 and names the failing dependency", async () => {
    const server = await build({
      readinessChecks: [
        { name: "postgres", check: ok },
        { name: "redis", check: down },
      ],
    });

    const res = await server.inject({ method: "GET", url: "/api/health/ready" });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: "unavailable",
      checks: { postgres: "ok", redis: "fail" },
    });
  });

  it("treats a hanging check as a failure", async () => {
    const server = await build({
      readinessTimeoutMs: 20,
      readinessChecks: [{ name: "postgres", check: () => new Promise(() => {}) }],
    });

    const res = await server.inject({ method: "GET", url: "/api/health/ready" });

    expect(res.statusCode).toBe(503);
  });
});

describe("request id", () => {
  it("reuses a well-formed incoming x-request-id", async () => {
    const server = await build();

    const res = await server.inject({
      method: "GET",
      url: "/api/health/live",
      headers: { "x-request-id": "proxy-abc-123" },
    });

    expect(res.headers["x-request-id"]).toBe("proxy-abc-123");
  });

  it("replaces a malformed one with a fresh UUID", async () => {
    const server = await build();

    const res = await server.inject({
      method: "GET",
      url: "/api/health/live",
      headers: { "x-request-id": "bad id\nwith newline" },
    });

    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("security headers", () => {
  it("are set by helmet", async () => {
    const server = await build();

    const res = await server.inject({ method: "GET", url: "/api/health/live" });

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});
