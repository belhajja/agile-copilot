# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/operator/package.json apps/operator/
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
  && cp -r packages/db/drizzle /out/migrate/drizzle \
  && node scripts/bundle-node.mjs apps/operator/src/cli.ts /out/operator/dist/operator.mjs

# Runtime base: Alpine with Node's binary only, without npm, yarn and corepack (unused at runtime).
# Same Alpine release as node:24-alpine (3.24), so the binary finds the libraries it was built for.
FROM node:24-alpine AS node
FROM alpine:3.24 AS runtime
# hadolint ignore=DL3018
RUN apk add --no-cache libstdc++ libgcc \
  && addgroup -g 10001 -S app && adduser -u 10001 -S app -G app
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app

# Runtime images run as uid/gid 10001: numeric, so Kubernetes' runAsNonRoot can verify it (Helm
# podSecurityContext, tested in packages/jira-tools/src/helm.test.ts).
FROM runtime AS migrate
COPY --from=bundle --chown=10001:10001 /out/migrate ./
USER 10001:10001
CMD ["node", "dist/migrate.mjs"]

FROM runtime AS worker
ENV NODE_ENV=production WORKER_HEALTH_PORT=8080 WORKER_HEALTH_HOST=0.0.0.0
COPY --from=bundle --chown=10001:10001 /out/worker ./
USER 10001:10001
EXPOSE 8080
CMD ["node", "dist/worker.mjs"]

FROM runtime AS runner
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=10001:10001 /repo/apps/web/.next/standalone ./
COPY --from=build --chown=10001:10001 /repo/apps/web/.next/static ./apps/web/.next/static
USER 10001:10001
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# The operator: installs and upgrades the stack on a Docker host through the mounted socket
# (docker run -v /var/run/docker.sock:/var/run/docker.sock -v <folder>:/data <image> install).
FROM runtime AS operator
# hadolint ignore=DL3018
RUN apk add --no-cache docker-cli docker-cli-compose
ARG OPERATOR_VERSION=develop
ARG OPERATOR_IMAGE_BASE=registry.gitlab.tech.orange/mohamedamine.belhajja/jira-agentic-ai
ENV OPERATOR_VERSION=$OPERATOR_VERSION OPERATOR_IMAGE_BASE=$OPERATOR_IMAGE_BASE \
  OPERATOR_DATA_DIR=/data
WORKDIR /opt/operator
COPY --from=bundle /out/operator ./
COPY docker-compose.selfhost.yml docker-compose.server.yml assets/
COPY docker/postgres/init/01-app-role.sh assets/postgres-init.sh
COPY docker/caddy/Caddyfile assets/Caddyfile
# Root on purpose: the Docker socket it drives is root-equivalent anyway.
# hadolint ignore=DL3002
USER 0:0
ENTRYPOINT ["node", "/opt/operator/dist/operator.mjs"]
