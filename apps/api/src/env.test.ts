import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.ts";

const valid = {
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/waitless",
  REDIS_URL: "redis://localhost:6379",
  APP_ORIGIN: "http://localhost:3000",
};

describe("loadEnv", () => {
  it("applies defaults and coerces numbers", () => {
    const env = loadEnv({ ...valid, API_PORT: "4000" });

    expect(env.API_PORT).toBe(4000);
    expect(env.NODE_ENV).toBe("development");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.TRUST_PROXY).toBe(false);
  });

  it("normalizes APP_ORIGIN and parses TRUST_PROXY", () => {
    const env = loadEnv({ ...valid, APP_ORIGIN: "https://waitless.example/", TRUST_PROXY: "1" });

    expect(env.APP_ORIGIN).toBe("https://waitless.example");
    expect(typeof env.TRUST_PROXY).toBe("function");
    expect(loadEnv({ ...valid, TRUST_PROXY: "loopback,10.0.0.0/8" }).TRUST_PROXY).toBe(
      "loopback,10.0.0.0/8",
    );
  });

  it("rejects a non-Postgres DATABASE_URL", () => {
    expect(() => loadEnv({ ...valid, DATABASE_URL: "mysql://localhost/waitless" })).toThrow(
      /DATABASE_URL/,
    );
  });

  it("names missing variables without echoing any values", () => {
    const secret = "postgres://u:s3cr3t-password@db/waitless";

    let message = "";
    try {
      loadEnv({ DATABASE_URL: secret });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/REDIS_URL/);
    expect(message).not.toContain("s3cr3t-password");
  });
});
