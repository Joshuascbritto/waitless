import path from "node:path";
import type { NextConfig } from "next";
import { resolveApiOrigin } from "./src/lib/api-origin";

const apiOrigin = resolveApiOrigin(process.env.API_ORIGIN);

const nextConfig: NextConfig = {
  // Self-contained server for the Docker image (deploy/docker/web.Dockerfile).
  output: "standalone",
  // Monorepo: trace dependencies from the repo root, not just apps/web.
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  // Same-origin routing (SPEC §4, ADR-0007): the browser only talks to the web
  // origin. In dev, Next proxies /api/* to Fastify; in prod the ingress does it.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }];
  },
};

export default nextConfig;
