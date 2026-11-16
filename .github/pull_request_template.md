## What and why

<!-- One concern per PR. Link the issue or SPEC section. -->

## How it was tested

<!-- Unit / integration / e2e, or the manual steps. -->

## Checklist

- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass
- [ ] Tenant-scoped data is only accessed through `withTenant` (SPEC §9)
- [ ] New environment variables are in `.env.example`; no secrets committed
- [ ] Docs updated (SPEC, ROADMAP, an ADR for any non-obvious decision)
