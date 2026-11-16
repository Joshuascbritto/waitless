# syntax=docker/dockerfile:1.7
# Web image: Next.js standalone output (a minimal server.js with only the
# files it traced as needed). Build from the repo root:
#   docker build -f deploy/docker/web.Dockerfile .

FROM node:24.22.3-bookworm-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm fetch --frozen-lockfile
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --offline --frozen-lockfile \
 && pnpm turbo run build --filter=@waitless/web...

FROM node:24.22.3-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
# Standalone keeps the monorepo layout: the server lives at apps/web/server.js.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
