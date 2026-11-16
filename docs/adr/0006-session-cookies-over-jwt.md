# 0006. Session cookies over JWT
Date: 2026-11-16
Status: Accepted

## Context

Staff and owners sign in to the admin dashboard. The web app and the API share one origin (ADR-0007). There is one API service (replicated) and no third-party clients. Admin actions need to be revocable immediately: an owner removing a staff member, or a user signing out on a shared counter computer.

## Options considered

1. **JWT access token (+ refresh token)**
   - Pros: stateless verification, no database lookup per request; a common pattern for APIs used by many services.
   - Cons: can't be revoked before expiry without a denylist (which reintroduces server state); refresh-token rotation adds complexity; tokens stored in `localStorage` are readable by any XSS.
2. **Opaque session id in an HttpOnly cookie, stored server-side**
   - Pros: instant revocation (delete the row); the browser handles storage; HttpOnly keeps it away from JavaScript; easy to reason about.
   - Cons: one indexed lookup per authenticated request; needs CSRF protection because the browser sends the cookie automatically.

## Decision

Option 2.

- **Token**: 256 random bits, base64url, only in the cookie. The `sessions` table stores `sha256(token)`, so a leaked table or backup can't be replayed. A plain hash is enough: the input already has 256 bits of entropy, so there is nothing to brute-force (unlike passwords).
- **Cookie**: `__Host-waitless_session; HttpOnly; Secure; SameSite=Lax; Path=/`. The `__Host-` prefix makes browsers reject it unless it's Secure, host-only and `Path=/`, so a subdomain can't overwrite it.
- **Expiry**: 14 days, sliding. To avoid a database write on every request, the session is extended only when less than half its lifetime remains (`shouldRenewSession`). An active user renews about once a week and never gets logged out; an idle session dies after 14 days.
- **New id on every login**, so a session id planted before login is useless (session fixation).
- **CSRF**: `SameSite=Lax` stops the cookie on cross-site POSTs; every state-changing request must also carry `Origin` equal to `APP_ORIGIN`. This works without CSRF tokens because of the single origin.
- **Passwords**: argon2id (19 MiB, 2 iterations, 1 lane, OWASP baseline). Login answers the same 401 for an unknown email and a wrong password, and runs a dummy hash for unknown emails so timing doesn't reveal which accounts exist. Login is rate limited to 5 per minute per IP and email (Redis).

## Consequences

- Easier: sign-out and access removal take effect on the next request; nothing sensitive is reachable from JavaScript.
- Harder: every authenticated request costs one primary-key lookup (cheap at this scale; cacheable in Redis later if it shows up in profiles). Expired rows are deleted by the worker's daily maintenance job (BullMQ).
- Server components in Next.js can read the session (they forward the cookie to the API) but can't write the renewed cookie back; renewal happens on the browser's own `/api` calls.
- Revisit if third-party or mobile clients need API access: they would get separate, scoped API tokens, not these cookies.
