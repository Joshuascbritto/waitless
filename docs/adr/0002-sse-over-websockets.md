# 0002. Server-Sent Events over WebSockets for real-time updates
Date: 2026-11-16
Status: Accepted

## Context

Customers watch their ticket on a phone; staff watch the queue board on a laptop or tablet. Both need changes within a second: "It's your turn" can't wait for a 5-second poll. Every change originates from a normal HTTP action (join, call next, finish…), so updates only need to flow **server → client**.

Phones switch networks and sleep, so connections drop often and must recover by themselves. The app runs behind an ingress (Caddy locally, Kubernetes Ingress in production), authenticates staff with an HttpOnly session cookie (ADR-0006), and serves web and API from one origin (ADR-0007).

## Options considered

1. **Polling** (what Phase 2 shipped)
   - Pros: trivial; works everywhere.
   - Cons: latency equals the interval; load grows with clients × frequency even when nothing changes.
2. **WebSockets**
   - Pros: bidirectional, low overhead per message, widely supported.
   - Cons: a second protocol next to REST, needing an `Upgrade`-aware proxy and ingress configuration; no built-in reconnect or resume, so a client library or hand-written backoff is needed; cookie authentication works but CSRF-style origin checks must be added by hand; the bidirectionality would go unused.
3. **Server-Sent Events**
   - Pros: plain HTTP (`text/event-stream`), so proxies, ingress, cookies and the existing auth/membership preHandlers work unchanged; `EventSource` reconnects automatically and supports `Last-Event-ID`; tiny server implementation.
   - Cons: server → client only; text only; browsers cap ~6 HTTP/1.1 connections per origin (a non-issue over HTTP/2, and each page holds one stream).

## Decision

Option 3. Client actions stay normal REST calls; each page holds one SSE stream.

- `GET /api/public/q/:tenantSlug/t/:token/stream` sends a `ticket` event with exactly the payload of the ticket GET (already redacted: no other customer's data).
- `GET /api/admin/:tenantSlug/queues/:queueId/stream` sends a `board` event with the **whole board**, on connect and after every change. This deviates from the original plan of incremental `ticket.created`/`ticket.updated` events: the refresh query already produces the full board, it is a few dozen rows, and the browser never has to merge partial updates (a push-back reorders the line).
- On every (re)connect the server sends the full current state, so no event replay is needed; `Last-Event-ID` is unused on purpose.
- Headers: `Cache-Control: no-cache`, `X-Accel-Buffering: no`; `retry: 3000`; a `: ping` comment every 15 s keeps idle proxies from closing the stream and detects dead clients.
- Streams are ended in Fastify's `preClose` hook, so a rolling deploy doesn't hang on open connections; clients reconnect to another replica.
- Public streams are capped per IP (generous, because a shop's Wi-Fi or a mobile carrier's CGNAT puts many customers behind one address).

Verified: the Next.js dev rewrite does **not** buffer the stream (event delivered ~26 ms after the action), so development needs no CORS exception. Caddy is configured with `flush_interval -1`.

## Consequences

- Easier: one protocol for everything; auth, tenancy checks and logging are shared with REST; reconnection is free.
- Harder: each open stream is a long-lived request, so instances must close them on shutdown and proxies must allow long timeouts (Phase 6 Ingress settings).
- Each instance must learn about changes made on other instances: see ADR-0004.
- Revisit if a feature needs client → server streaming (e.g. live chat with the shop); WebSockets would be added for that feature only.
