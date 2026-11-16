/**
 * Fixed-window counters in Redis, for routes that need more than one limit.
 * (@fastify/rate-limit runs at most one limiter per request by design, so
 * the join route's per-device AND per-IP limits are checked here.)
 */
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";

export interface WindowLimit {
  key: string;
  max: number;
  windowMs: number;
}

export interface LimitResult {
  allowed: boolean;
  /** Milliseconds until the window that blocked resets (0 when allowed). */
  retryAfterMs: number;
}

const PREFIX = "waitless:limit:";

/**
 * Counts this request against every limit; blocked if any is exceeded.
 * INCR + PEXPIRE NX run in one MULTI, so the first hit starts the window
 * and later hits never extend it. If Redis is unavailable the request is
 * allowed (same trade-off as the login limiter: availability over a short
 * pause in brute-force protection).
 */
export async function hitLimits(
  redis: Redis,
  limits: WindowLimit[],
  log: FastifyBaseLogger,
): Promise<LimitResult> {
  try {
    const pipeline = redis.multi();
    for (const limit of limits) {
      pipeline
        .incr(PREFIX + limit.key)
        .pexpire(PREFIX + limit.key, limit.windowMs, "NX")
        .pttl(PREFIX + limit.key);
    }
    const replies = (await pipeline.exec()) ?? [];

    let retryAfterMs = 0;
    limits.forEach((limit, index) => {
      const count = Number(replies[index * 3]?.[1] ?? 0);
      const ttl = Number(replies[index * 3 + 2]?.[1] ?? limit.windowMs);
      if (count > limit.max) retryAfterMs = Math.max(retryAfterMs, ttl);
    });
    return { allowed: retryAfterMs === 0, retryAfterMs };
  } catch (err) {
    log.warn({ err }, "rate limit check failed; allowing the request");
    return { allowed: true, retryAfterMs: 0 };
  }
}
