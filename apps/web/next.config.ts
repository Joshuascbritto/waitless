import type { NextConfig } from "next";
import { resolveApiOrigin } from "./src/lib/api-origin";

const apiOrigin = resolveApiOrigin(process.env.API_ORIGIN);

const nextConfig: NextConfig = {
  // Same-origin routing (SPEC §4, ADR-0007): the browser only talks to the web
  // origin. In dev, Next proxies /api/* to Fastify; in prod the ingress does it.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }];
  },
};

export default nextConfig;
