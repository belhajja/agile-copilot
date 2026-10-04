# Agile Copilot

Agile Copilot is a dashboard and AI agent for managers running Scrum or Kanban projects in Jira. It aims to give reliable, actionable insight (sprint health, flow, risks, forecasts) without analyst skills: you bring your own LLM key (BYOK), connect Jira (Cloud or Server/Data Center), and personalise the analysis by writing natural-language instructions. The UI is bilingual (English and French). This repository holds Phases 1 and 2: workspaces and roles, encrypted Jira and LLM connections, a background worker that syncs Jira boards, sprints and issue history, a deterministic metrics engine, and default Scrum and Kanban dashboards that work without any LLM. See `docs/superpowers/specs/2026-10-03-agile-copilot-design.md` for the full design.

Authentication today is email and password. The plan is to add Keycloak/OIDC single sign-on later, with password login then restricted to admins.

## Quick start (development)

Requirements: Node 24, pnpm (via corepack), Docker.

```bash
pnpm install
docker compose up -d postgres          # dev Postgres on host port 5433
cp .env.example .env
```

`.env` files do not evaluate shell substitutions, so generate the secrets in your shell and paste the output. Run `openssl rand -base64 32` twice, then set:

```bash
BETTER_AUTH_SECRET=<paste-output-here>
ENCRYPTION_KEYS=v1:<paste-output-here>
```

Or append generated values in one go (remove the empty `BETTER_AUTH_SECRET=` and `ENCRYPTION_KEYS=` lines from `.env` first, since the last duplicate wins in some loaders but not all):

```bash
printf 'BETTER_AUTH_SECRET=%s\nENCRYPTION_KEYS=v1:%s\n' "$(openssl rand -base64 32)" "$(openssl rand -base64 32)" >> .env
```

Then:

```bash
pnpm db:migrate
pnpm dev                               # web on http://localhost:3000 + the sync worker
```

`pnpm dev` starts both the web app and the sync worker (`apps/worker`). Run the worker alone with `pnpm --filter @agile/worker dev`; it needs the migrations applied first.

Environment variables are read lazily at request time, so `next build` needs none.

## Self-hosting

`docker-compose.selfhost.yml` runs Postgres, a one-shot `migrate` service, the web app, and the sync worker.

```bash
cp .env.example .env
# fill BETTER_AUTH_SECRET, ENCRYPTION_KEYS (v1:<base64>), POSTGRES_PASSWORD, APP_DB_PASSWORD
# (paste generated values; .env does not run $(...). Use `openssl rand -hex 24` for the two passwords)
# set BETTER_AUTH_URL to the public URL of the app
docker compose -f docker-compose.selfhost.yml up -d --build
```

The `migrate` service connects as the database owner and must exit 0 before `web` and `worker` start; both connect as the non-owner `app_user` role so row-level security applies. The worker has no published port; its health endpoint (`/health`, port 8080 on `0.0.0.0` inside the container) is used by the container health check, and its `stop_grace_period` is 60 s because it drains running jobs (up to 30 s, plus a 45 s backstop) before exiting. The app is published on `${WEB_PORT:-3000}`; if you change it, update `BETTER_AUTH_URL` to match. Put a TLS-terminating reverse proxy in front of it for anything beyond a local trial.

`POSTGRES_PASSWORD` and `APP_DB_PASSWORD` are inserted unescaped into SQL and into connection URLs, so they must be URL-safe and contain no quotes; generate them with `openssl rand -hex 24`.

The init script that creates `app_user` only runs when the Postgres volume is first created. Changing `APP_DB_PASSWORD` afterwards has no effect on the database by itself. Either update the role in place:

```bash
docker compose -f docker-compose.selfhost.yml exec postgres psql -U agile -d agile -c "ALTER ROLE app_user PASSWORD '<new-password>'"
docker compose -f docker-compose.selfhost.yml up -d web
```

or recreate the volume, which destroys all data:

```bash
docker compose -f docker-compose.selfhost.yml down -v
docker compose -f docker-compose.selfhost.yml up -d --build
```

Set `ALLOWED_PRIVATE_HOSTS` (comma-separated hostnames, e.g. `jira.corp.local,ollama.internal`) to let self-hosted Jira or Ollama instances resolve to private addresses; by default outbound requests to private ranges are blocked. Never expose Postgres publicly: the compose file deliberately publishes no database port.

### Worker settings and the `pgboss` schema

| Variable | Default | Meaning |
|---|---|---|
| `SYNC_INTERVAL_MINUTES` | `15` | Minutes between scheduled syncs; one of 5, 10, 15, 30, 60 (anything else stops the worker at start-up). |
| `WORKER_HEALTH_PORT` | `8080` | Port of the worker's `/health` endpoint. |
| `WORKER_HEALTH_HOST` | `127.0.0.1` | Interface of `/health`; the self-host compose sets `0.0.0.0` inside the container. |

The job queue (pg-boss) lives in a `pgboss` schema that migration 0005 creates with `AUTHORIZATION app_user`, so the web app and worker can run it without owner credentials. Two things to know on managed Postgres:

- On PostgreSQL 16+ the role running migrations must be able to `SET ROLE app_user` to create a schema owned by it: `GRANT app_user TO <migration owner>;`.
- The migration uses `CREATE SCHEMA IF NOT EXISTS`. If a `pgboss` schema already exists with a different owner, it is skipped silently and the worker cannot install its tables; fix the ownership by hand (`ALTER SCHEMA pgboss OWNER TO app_user;`, and likewise for any tables already in it).

## Connect with Atlassian (optional)

To offer "Connect with Atlassian" (OAuth 2.0 3LO) for Jira Cloud:

1. Create an OAuth 2.0 (3LO) app at <https://developer.atlassian.com/console/myapps/>.
2. Under Authorization, add the callback URLs `https://<your-domain>/api/jira/oauth/callback` and, for development, `http://localhost:3000/api/jira/oauth/callback`.
3. Under Permissions, enable the scopes `read:jira-work read:jira-user write:jira-work read:board-scope:jira-software read:sprint:jira-software offline_access`.
4. Put the client id and secret in `ATLASSIAN_OAUTH_CLIENT_ID` and `ATLASSIAN_OAUTH_CLIENT_SECRET`, then restart.

Without these variables, users can still connect with an API token (Cloud) or a personal access token (Data Center). Note: the OAuth flow has not yet been verified against a real Atlassian tenant. Do a manual check before relying on it.

## Jira sync and dashboards

1. In **Settings → Jira**, open a connection's **Boards**, load the boards, and select the ones to sync.
2. Check the **status mapping** of each board. Every Jira status counts as *To do*, *In progress* or *Done* (suggested from Jira's status categories). Mark in-progress statuses where work only waits (for example *Blocked* or *Waiting for review*): flow efficiency counts that time as waiting.
3. Click **Sync now**, or wait for the scheduled sync (every `SYNC_INTERVAL_MINUTES`, default 15). The first sync of a connection reads every issue of the selected boards; later syncs read only issues updated since the previous sync (with a 15-minute overlap), and once a day the worker re-reads everything so that issues which left a board disappear from it.
4. Open the board from the home page. Scrum boards get a *Sprint* and a *Flow* dashboard; Kanban boards a *Flow* dashboard.

How the numbers are defined:

- **Velocity**: *committed* is what was in the sprint when it started (estimates as of the start); *completed* is what was done when it closed (estimates as of the close), including work added mid-sprint. Boards without an estimation field use issue counts.
- **Cycle time** runs from the first move to an in-progress status to the final move to done; **lead time** from creation to done. Percentiles use the nearest-rank method.
- **Flow efficiency** is the share of cycle time not spent in a *waiting* status or flagged as an impediment.
- **Forecasts** are Monte Carlo simulations (10 000 runs, fixed seed) drawn from the last 30 days of daily throughput.
- Days are UTC calendar days. Sub-tasks are left out (as in Jira's own reports).

The sync never stores raw Jira error messages: a failed sync shows a short reason (for example *Jira rejected the stored credentials*) and is retried at the next schedule.

## Validating against a real Jira

Automated tests run the same contract against a Cloud-flavoured and a Data Center-flavoured mock Jira (REST v3/`search/jql` with page tokens, REST v2/`search` with offsets, the Agile API, truncated changelogs and HTTP 429). Before relying on a new Jira version, run this checklist once against a real site (a [Data Center trial container](https://hub.docker.com/r/atlassian/jira-software) with a time-bombed licence, and a Jira Cloud sandbox):

1. Connect it (Cloud: API token and "Connect with Atlassian"; Data Center: personal access token). Self-hosted Data Center needs its host in `ALLOWED_PRIVATE_HOSTS`.
2. Load boards: every Scrum and Kanban board you can see in Jira is listed, with the right type, and Scrum boards show "Story points".
3. Status mapping: every column status appears, with a sensible suggestion.
4. Select one Scrum and one Kanban board and click **Sync now**. In Jira, run the board's filter (`filter = <id>` in issue search): the number of issues matches the board's dashboards' data, and the closed sprints match the sprint report's committed/completed values for a sprint with no mid-sprint estimate changes.
5. Move an issue to another status in Jira, wait for the next scheduled sync (or click **Sync now**), and check that cycle time / WIP change accordingly.
6. With a board of more than 100 issues, check that all of them were read (pagination) and that an issue with more than 100 changelog entries has its full history.
7. Note the Jira version and the date in the pull request that validated it.

## Rotating the encryption key

`ENCRYPTION_KEYS` is a comma-separated list of versioned 32-byte keys. To rotate, append `v2:<new base64 key>` and restart. New organisation keys are wrapped with v2; existing ones still decrypt with v1, so keep v1 in the list. A re-wrap command to retire old versions is not available yet (planned for Phase 5).

## Security model

- Row-level security in Postgres as a second guard behind application checks; the app runs as the non-owner `app_user`, which cannot update or delete the audit log.
- Secrets (Jira tokens, LLM API keys) are encrypted with AES-256-GCM using a per-organisation data key, itself wrapped by the key-encryption key from `ENCRYPTION_KEYS`. Secrets never go to the browser.
- Every connection change is written to an audit log.
- Connections are tested before they are saved (Jira reachability; LLM tool-calling support).
- An outbound URL guard blocks requests to private, loopback and link-local addresses unless the host is in `ALLOWED_PRIVATE_HOSTS`.

### Known limitations

- DNS rebinding between the outbound-URL check and the actual connection is not yet pinned (planned for Phase 3). The sync re-checks the outbound URL policy before every run.
- The key-rotation re-wrap command does not exist yet (Phase 5).

## Development

```bash
pnpm test        # unit and integration tests (Vitest; needs Docker for Testcontainers)
pnpm e2e         # Playwright end-to-end tests (needs the dev Postgres from `docker compose up -d postgres`)
pnpm lint        # Biome
pnpm typecheck
```

Docker is required for tests because the database tests start Postgres through Testcontainers. The e2e suite runs the web app on port 3200 and the sync worker (health on 4030) against Postgres on 5433, with local mock Jira (4010, serving a demo dataset) and LLM (4020) servers. The first visit of each page makes `next dev` compile it; if a cold run times out, run it again (CI uses longer timeouts: `CI=true pnpm e2e`).
