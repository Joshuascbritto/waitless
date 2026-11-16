# Waitless

A multi-tenant virtual queue for small businesses: customers scan a QR code, join the line from their phone, watch their position update live and get a push notification when it's their turn.

> **Work in progress.** The product and architecture spec is in [docs/SPEC.md](docs/SPEC.md), and progress is tracked in [docs/ROADMAP.md](docs/ROADMAP.md).

## Run locally

Requires Node.js 24, pnpm 12 and Docker.

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm dev
```

Web: http://localhost:3000 · API health: http://localhost:3000/api/health/ready
