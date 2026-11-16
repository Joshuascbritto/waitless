import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.ts";

const valid = {
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/waitless",
  REDIS_URL: "redis://localhost:6379",
};

describe("loadEnv", () => {
  it("applies defaults and coerces numbers", () => {
    const env = loadEnv({ ...valid, API_PORT: "4000" });

    expect(env.API_PORT).toBe(4000);
    expect(env.NODE_ENV).toBe("development");
    expect(env.LOG_LEVEL).toBe("info");
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
