# Agile Copilot

Agile Copilot is a dashboard and AI agent for managers running Scrum or Kanban projects in Jira. It aims to give reliable, actionable insight (sprint health, flow, risks, forecasts) without analyst skills: you bring your own LLM key (BYOK), connect Jira (Cloud or Server/Data Center), and personalise the analysis by writing natural-language instructions. The UI is bilingual (English and French). This repository holds the Phase 1 foundation: workspaces and roles, an encrypted Jira connection, per-organisation LLM configuration, and the self-host packaging. See `docs/superpowers/specs/2026-10-03-agile-copilot-design.md` for the full design.

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
pnpm dev                               # http://localhost:3000
```

Environment variables are read lazily at request time, so `next build` needs none.

## Self-hosting

`docker-compose.selfhost.yml` runs Postgres, a one-shot `migrate` service, and the web app.

```bash
cp .env.example .env
# fill BETTER_AUTH_SECRET, ENCRYPTION_KEYS (v1:<base64>), POSTGRES_PASSWORD, APP_DB_PASSWORD
# (paste generated values; .env does not run $(...). Use `openssl rand -hex 24` for the two passwords)
# set BETTER_AUTH_URL to the public URL of the app
docker compose -f docker-compose.selfhost.yml up -d --build
```

The `migrate` service connects as the database owner and must exit 0 before `web` starts; the web container connects as the non-owner `app_user` role so row-level security applies. The app is published on `${WEB_PORT:-3000}`; if you change it, update `BETTER_AUTH_URL` to match. Put a TLS-terminating reverse proxy in front of it for anything beyond a local trial.

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

## Connect with Atlassian (optional)

To offer "Connect with Atlassian" (OAuth 2.0 3LO) for Jira Cloud:

1. Create an OAuth 2.0 (3LO) app at <https://developer.atlassian.com/console/myapps/>.
2. Under Authorization, add the callback URLs `https://<your-domain>/api/jira/oauth/callback` and, for development, `http://localhost:3000/api/jira/oauth/callback`.
3. Under Permissions, enable the scopes `read:jira-work read:jira-user write:jira-work read:board-scope:jira-software read:sprint:jira-software offline_access`.
4. Put the client id and secret in `ATLASSIAN_OAUTH_CLIENT_ID` and `ATLASSIAN_OAUTH_CLIENT_SECRET`, then restart.

Without these variables, users can still connect with an API token (Cloud) or a personal access token (Data Center). Note: the OAuth flow has not yet been verified against a real Atlassian tenant. Do a manual check before relying on it.

## Rotating the encryption key

`ENCRYPTION_KEYS` is a comma-separated list of versioned 32-byte keys. To rotate, append `v2:<new base64 key>` and restart. New organisation keys are wrapped with v2; existing ones still decrypt with v1, so keep v1 in the list. A re-wrap command to retire old versions is not available yet (planned for Phase 5).

## Security model

- Row-level security in Postgres as a second guard behind application checks; the app runs as the non-owner `app_user`, which cannot update or delete the audit log.
- Secrets (Jira tokens, LLM API keys) are encrypted with AES-256-GCM using a per-organisation data key, itself wrapped by the key-encryption key from `ENCRYPTION_KEYS`. Secrets never go to the browser.
- Every connection change is written to an audit log.
- Connections are tested before they are saved (Jira reachability; LLM tool-calling support).
- An outbound URL guard blocks requests to private, loopback and link-local addresses unless the host is in `ALLOWED_PRIVATE_HOSTS`.

### Known limitations

- DNS rebinding between the outbound-URL check and the actual connection is not yet pinned (planned for Phase 3).
- The key-rotation re-wrap command does not exist yet (Phase 5).

## Development

```bash
pnpm test        # unit and integration tests (Vitest; needs Docker for Testcontainers)
pnpm e2e         # Playwright end-to-end tests (needs the dev Postgres from `docker compose up -d postgres`)
pnpm lint        # Biome
pnpm typecheck
```

Docker is required for tests because the database tests start Postgres through Testcontainers. The e2e suite runs the web app on port 3200 against Postgres on 5433, with local mock Jira and LLM servers.
