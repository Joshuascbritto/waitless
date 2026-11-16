import type { FastifyServerOptions } from "fastify";
import { z } from "zod";

/**
 * Fastify `trustProxy` from a string: "true"/"false", a hop count ("1"), or
 * comma-separated addresses, CIDRs or keywords ("loopback,10.0.0.0/8").
 */
const TrustProxySchema = z
  .string()
  .trim()
  .min(1)
  .transform((value): NonNullable<FastifyServerOptions["trustProxy"]> => {
    if (value === "true") return true;
    if (value === "false") return false;
    if (/^\d+$/.test(value)) {
      // Trust the nearest N proxies (what a numeric trustProxy means in proxy-addr).
      const hops = Number(value);
      return (_address: string, hop: number) => hop < hops;
    }
    return value;
  });

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  API_HOST: z.string().min(1).default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  /** The web app's origin: the only one allowed to make state-changing requests. */
  APP_ORIGIN: z.url({ protocol: /^https?$/ }).transform((url) => new URL(url).origin),
  TRUST_PROXY: TrustProxySchema.default(false),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Validates configuration once at startup, so a typo fails the boot with a
 * clear message instead of failing the first request that needs it.
 * The error lists which variables are wrong, never their values (they may be secrets).
 */
export function loadEnv(source: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
