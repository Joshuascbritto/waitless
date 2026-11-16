/**
 * Integration harness: the real app wired to a real Postgres 18 (bootstrapped
 * and migrated like production) and a real Redis 8, in containers.
 */
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { createDb, createPool, type Db } from "@waitless/db";
import { startTestDatabase, type TestDatabase } from "@waitless/db/testing";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { Redis } from "ioredis";
import { buildApp } from "../app.ts";

export const APP_ORIGIN = "http://localhost:3000";

export interface Harness {
  app: FastifyInstance;
  db: Db;
  pool: ReturnType<typeof createPool>;
  stop(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  let database: TestDatabase | undefined;
  let redisContainer: StartedRedisContainer | undefined;
  [database, redisContainer] = await Promise.all([
    startTestDatabase(),
    new RedisContainer("redis:8.8.4-alpine").start(),
  ]);

  const pool = createPool(database.appUrl);
  const redis = new Redis(redisContainer.getConnectionUrl());
  const db = createDb(pool);
  const app = await buildApp({
    logger: false,
    readinessChecks: [],
    docs: true,
    services: { db, redis, appOrigin: APP_ORIGIN },
  });

  return {
    app,
    db,
    pool,
    stop: async () => {
      await app.close();
      await pool.end();
      redis.disconnect();
      await Promise.all([database?.stop(), redisContainer?.stop()]);
    },
  };
}

/** The session cookie value from a response, as a Cookie header for the next request. */
export function sessionCookieFrom(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find((c) => c.name === "__Host-waitless_session");
  if (!cookie) {
    throw new Error(`no session cookie in response (status ${res.statusCode})`);
  }
  return `${cookie.name}=${cookie.value}`;
}

let counter = 0;
/** A unique email per call, so tests don't collide on the unique index or the rate limiter. */
export function uniqueEmail(prefix = "user"): string {
  counter += 1;
  return `${prefix}-${counter}-${Date.now()}@example.com`;
}

/** Registers a user and returns its session cookie. */
export async function registerUser(
  app: FastifyInstance,
  email = uniqueEmail(),
): Promise<{ cookie: string; email: string; id: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    headers: { origin: APP_ORIGIN },
    payload: { email, password: "correct horse battery", name: "Test User" },
  });
  if (res.statusCode !== 201) {
    throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  }
  return { cookie: sessionCookieFrom(res), email, id: res.json().user.id };
}
