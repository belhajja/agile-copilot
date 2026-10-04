# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS base
# Pre-fetch pnpm so the migrate container runs without network access.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY e2e/package.json e2e/
COPY packages/ packages/
RUN find packages -type f ! -name package.json -delete
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @agile/web build

FROM base AS migrate
COPY --from=build /repo /repo
CMD ["pnpm", "db:migrate"]

# The worker ships TypeScript sources run by tsx; `pnpm deploy` copies it with production deps only.
FROM deps AS worker-build
COPY . .
RUN pnpm --filter @agile/worker deploy --prod --legacy /out

FROM node:24-alpine AS worker
ENV NODE_ENV=production WORKER_HEALTH_PORT=8080 WORKER_HEALTH_HOST=0.0.0.0
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=worker-build --chown=app:app /out ./
USER app
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/main.ts"]

FROM node:24-alpine AS runner
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /repo/apps/web/.next/standalone ./
COPY --from=build --chown=app:app /repo/apps/web/.next/static ./apps/web/.next/static
USER app
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
