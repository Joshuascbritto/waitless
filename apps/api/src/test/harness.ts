/**
 * Integration harness: the real app wired to a real Postgres 18 (bootstrapped
 * and migrated like production) and a real Redis 8, in containers.
 */
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { createDb, type Db } from "@waitless/db";
import { createTestPool, startTestDatabase, type TestDatabase } from "@waitless/db/testing";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { Redis } from "ioredis";
import { buildApp } from "../app.ts";

export const APP_ORIGIN = "http://localhost:3000";

export interface Harness {
  app: FastifyInstance;
  db: Db;
  pool: ReturnType<typeof createTestPool>;
  /** A command connection to the shared Redis, for assertions (e.g. PUBSUB NUMSUB). */
  redis: Redis;
  /**
   * Another API instance on the same Postgres and Redis, like a second replica:
   * its own pool, Redis connections and subscriptions. Closed by stop().
   */
  startInstance(): Promise<FastifyInstance>;
  stop(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  let database: TestDatabase | undefined;
  let redisContainer: StartedRedisContainer | undefined;
  [database, redisContainer] = await Promise.all([
    startTestDatabase(),
    new RedisContainer("redis:8.8.4-alpine").start(),
  ]);
  const appUrl = database.appUrl;
  const redisUrl = redisContainer.getConnectionUrl();

  const instances: Array<{
    app: FastifyInstance;
    pool: ReturnType<typeof createTestPool>;
    redis: Redis;
  }> = [];
  async function startInstance() {
    const pool = createTestPool(appUrl);
    const redis = new Redis(redisUrl);
    const app = await buildApp({
      logger: false,
      readinessChecks: [],
      docs: true,
      services: { db: createDb(pool), redis, appOrigin: APP_ORIGIN },
    });
    instances.push({ app, pool, redis });
    return app;
  }

  const app = await startInstance();
  const pool = createTestPool(appUrl);
  const redis = new Redis(redisUrl);

  return {
    app,
    db: createDb(pool),
    pool,
    redis,
    startInstance,
    stop: async () => {
      for (const instance of instances) {
        await instance.app.close();
        await instance.pool.end();
        instance.redis.disconnect();
      }
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
