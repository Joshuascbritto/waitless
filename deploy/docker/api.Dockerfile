# syntax=docker/dockerfile:1.7
# API image; the worker (Phase 4) reuses it with another command.
# Build from the repo root: docker build -f deploy/docker/api.Dockerfile .

FROM node:24.22.3-bookworm-slim AS base
# pnpm version comes from package.json "packageManager".
RUN corepack enable
WORKDIR /repo

FROM base AS build
# Manifests first, so the dependency layer is cached until the lockfile changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --offline --frozen-lockfile \
 && pnpm turbo run build --filter=@waitless/api... \
 # A self-contained copy: production dependencies only, workspace packages
 # (shared, db with its migrations) copied in as regular packages.
 && pnpm --filter @waitless/api deploy --prod /out

FROM node:24.22.3-bookworm-slim AS runtime
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
# The image's built-in unprivileged user.
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/api/health/live').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server.js"]
