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

/** Web Push keys: all three or none (push is then disabled and the UI hides the button). */
const VapidSchema = {
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  VAPID_SUBJECT: z
    .string()
    .regex(/^(mailto:|https:\/\/)/, "must start with mailto: or https://")
    .optional(),
};

type VapidEnv = {
  VAPID_PUBLIC_KEY?: string | undefined;
  VAPID_PRIVATE_KEY?: string | undefined;
  VAPID_SUBJECT?: string | undefined;
};
const allOrNoneVapid = (env: VapidEnv) => {
  const set = [env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT].filter(Boolean);
  return set.length === 0 || set.length === 3;
};
const VAPID_MESSAGE = {
  message: "Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT together, or none of them",
  path: ["VAPID_PUBLIC_KEY"],
};

/**
 * Port for Prometheus `/metrics`, separate from the app port so the public
 * Ingress never exposes it. Unset: no metrics server (local dev, where the
 * API and the worker share one host).
 */
const MetricsSchema = {
  METRICS_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
};

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    API_HOST: z.string().min(1).default("0.0.0.0"),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    /** The web app's origin: the only one allowed to make state-changing requests. */
    APP_ORIGIN: z.url({ protocol: /^https?$/ }).transform((url) => new URL(url).origin),
    TRUST_PROXY: TrustProxySchema.default(false),
    /** Serve Swagger UI at /api/docs. On in development and the public demo, off otherwise. */
    API_DOCS: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    ...MetricsSchema,
    ...VapidSchema,
  })
  .refine(allOrNoneVapid, VAPID_MESSAGE);

export type Env = z.infer<typeof EnvSchema>;

/** The worker needs no HTTP settings. */
const WorkerEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    ...MetricsSchema,
    ...VapidSchema,
  })
  .refine(allOrNoneVapid, VAPID_MESSAGE);

export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;

export function loadWorkerEnv(source: Record<string, string | undefined>): WorkerEnv {
  const result = WorkerEnvSchema.safeParse(withoutEmpty(source));
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/**
 * Validates configuration once at startup, so a typo fails the boot with a
 * clear message instead of failing the first request that needs it.
 * The error lists which variables are wrong, never their values (they may be secrets).
 */
/** `KEY=` in a .env file (or `${KEY:-}` in compose) means "not set", not "set to empty". */
function withoutEmpty(source: Record<string, string | undefined>) {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
}

export function loadEnv(source: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(withoutEmpty(source));
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
