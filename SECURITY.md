# Security policy

Waitless stores personal data (names, optional emails, push subscriptions) for many businesses at once, so isolation and privacy bugs matter even in a demo.

## Reporting a vulnerability

Please report it privately through [GitHub security advisories](https://github.com/Joshuascbritto/waitless/security/advisories/new), not in a public issue. Include the steps to reproduce and what an attacker could do. You'll get an answer within a week.

Especially welcome: anything that lets one business read or change another's data, bypasses the session or CSRF checks, makes the server send requests to arbitrary hosts, or leaks tokens or contact details into logs.

## How the app defends itself

Tenant isolation with Postgres row-level security ([ADR-0001](docs/adr/0001-multi-tenancy-with-postgres-rls.md)); hashed, HttpOnly session cookies with an Origin check ([ADR-0006](docs/adr/0006-session-cookies-over-jwt.md)); argon2id passwords; rate limits on login and joining; push endpoints restricted to known push services ([ADR-0005](docs/adr/0005-web-push-over-whatsapp-sms.md)); security headers via helmet; non-root containers on read-only filesystems.
