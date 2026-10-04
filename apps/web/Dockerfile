# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS base
# Pre-fetch pnpm so the migrate container runs without network access (in a shared COREPACK_HOME:
# the migrate image runs as uid 10001, not root).
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_HOME=/opt/corepack
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY e2e/package.json e2e/
COPY evals/package.json evals/
COPY packages/ packages/
RUN find packages -type f ! -name package.json -delete
# The evals workspace (promptfoo, ~1.7 GB installed) is not part of any image.
RUN pnpm install --frozen-lockfile --filter '!@agile/evals'

FROM deps AS build
COPY . .
RUN pnpm --filter @agile/web build

# Runtime images run as uid/gid 10001: numeric, so Kubernetes' runAsNonRoot can verify it (Helm
# podSecurityContext, tested in packages/jira-tools/src/helm.test.ts).
FROM base AS migrate
RUN addgroup -g 10001 -S app && adduser -u 10001 -S app -G app
COPY --from=build /repo /repo
USER 10001:10001
CMD ["pnpm", "db:migrate"]

# The worker ships TypeScript sources run by tsx; `pnpm deploy` copies it with production deps only.
FROM deps AS worker-build
COPY . .
RUN pnpm --filter @agile/worker deploy --prod --legacy /out

FROM node:24-alpine AS worker
ENV NODE_ENV=production WORKER_HEALTH_PORT=8080 WORKER_HEALTH_HOST=0.0.0.0
WORKDIR /app
RUN addgroup -g 10001 -S app && adduser -u 10001 -S app -G app
COPY --from=worker-build --chown=10001:10001 /out ./
USER 10001:10001
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/main.ts"]

FROM node:24-alpine AS runner
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN addgroup -g 10001 -S app && adduser -u 10001 -S app -G app
COPY --from=build --chown=10001:10001 /repo/apps/web/.next/standalone ./
COPY --from=build --chown=10001:10001 /repo/apps/web/.next/static ./apps/web/.next/static
USER 10001:10001
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
