# 0007. Same-origin routing for web and API
Date: 2026-11-16
Status: Accepted

## Context

The web app (Next.js) and the API (Fastify) are separate processes, deployed as separate containers. The browser needs both: pages from the web app, data and real-time streams from the API. Authentication uses an HttpOnly session cookie (ADR-0006), and customers use the app on phones, where browsers increasingly block third-party cookies.

## Options considered

1. **Separate origins** (`app.example.com` and `api.example.com`)
   - Pros: independent deploys and caching rules per host; a common setup.
   - Cons: every call is cross-origin: CORS preflights, `credentials: "include"`, cookies scoped carefully across subdomains (or `SameSite=None`, which weakens CSRF protection), and Safari's tracking prevention can still interfere.
2. **Same origin, `/api` routed to the API** (by the ingress in production, by a Next.js rewrite in development)
   - Pros: no CORS at all; the session cookie is first-party and host-only (`__Host-` prefix works); `SameSite=Lax` plus an `Origin` check is a complete CSRF defense; one hostname and one TLS certificate.
   - Cons: the router must send `/api/*` and `/` to different services and must not buffer Server-Sent Events.

## Decision

Option 2. The browser only ever talks to the web origin.

- Production: the Kubernetes Ingress routes `/api` to the API service and everything else to the web service, with buffering off for SSE (Phase 6).
- Development: `next.config.ts` rewrites `/api/:path*` to `API_ORIGIN` (default `http://localhost:3001`). `TRUST_PROXY=loopback` lets the API see the real client IP through that local proxy.
- Next.js server components call the API directly at `API_ORIGIN`, forwarding the session cookie, so protected pages can redirect before rendering.
- The API rejects state-changing requests whose `Origin` isn't `APP_ORIGIN`.

## Consequences

- Easier: no CORS configuration anywhere; cookie and CSRF handling stay simple and strict.
- Harder: local development depends on the rewrite. Next.js rewrites may buffer SSE (Phase 3); if they do, development streams will point `EventSource` straight at the API origin with credentials, development only, and that exception will be documented.
- Revisit if the API gets third-party consumers; they would use a separate host with token authentication, leaving this setup in place for the web app.
