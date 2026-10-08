# syntax=docker/dockerfile:1.7
# Where the base images come from: Docker Hub, or a mirror of it (CI passes Orange's, whose
# runners hit Docker Hub's anonymous pull limit).
ARG BASE_REGISTRY=docker.io
FROM ${BASE_REGISTRY}/library/node:24-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY e2e/package.json e2e/
COPY evals/package.json evals/
COPY packages/ packages/
RUN find packages -type f ! -name package.json -delete && pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @agile/web build \
  # The runner is Alpine (musl): sharp's glibc builds are never loaded.
  && rm -rf apps/web/.next/standalone/node_modules/.pnpm/@img+sharp-libvips-linux-x64@* \
    apps/web/.next/standalone/node_modules/.pnpm/@img+sharp-linux-x64@*

# The worker and the migrations as single bundled files: no node_modules, tsx or pnpm at runtime.
# The SQL migrations sit next to the bundle, where packages/db/src/migrate.ts looks for them
# (`../drizzle` from the script).
FROM deps AS bundle
COPY . .
RUN node scripts/bundle-node.mjs apps/worker/src/main.ts /out/worker/dist/worker.mjs \
  && node scripts/bundle-node.mjs packages/db/src/migrate-cli.ts /out/migrate/dist/migrate.mjs \
  && cp -r packages/db/drizzle /out/migrate/drizzle

# Runtime base: Alpine with Node's binary only, without npm, yarn and corepack (unused at runtime).
# Same Alpine release as node:24-alpine (3.24), so the binary finds the libraries it was built for.
FROM ${BASE_REGISTRY}/library/node:24-alpine AS node
FROM ${BASE_REGISTRY}/library/alpine:3.24 AS runtime
# The base image's own packages get their security fixes here, not when a new alpine tag ships.
# hadolint ignore=DL3017,DL3018
RUN apk upgrade --no-cache && apk add --no-cache libstdc++ libgcc \
  && addgroup -g 10001 -S app && adduser -u 10001 -S app -G app
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app

# Runtime images run as uid/gid 10001: numeric, so Kubernetes' runAsNonRoot can verify it (Helm
# podSecurityContext, tested in packages/jira-tools/src/helm.test.ts). Their code stays owned by
# root: the app user can read it, not rewrite it.
FROM runtime AS migrate
COPY --from=bundle /out/migrate ./
USER 10001:10001
CMD ["node", "dist/migrate.mjs"]

FROM runtime AS worker
ENV NODE_ENV=production WORKER_HEALTH_PORT=8080 WORKER_HEALTH_HOST=0.0.0.0
COPY --from=bundle /out/worker ./
USER 10001:10001
EXPOSE 8080
CMD ["node", "dist/worker.mjs"]

FROM runtime AS runner
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
# The only directory the server writes to (besides /tmp).
RUN mkdir -p apps/web/.next/cache && chown 10001:10001 apps/web/.next/cache
USER 10001:10001
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
