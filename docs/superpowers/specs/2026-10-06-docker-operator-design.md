# Docker operator: install and upgrade the self-host stack

_Design approved in chat on 2026-10-06._

## Purpose

Installing Agile Copilot on a Docker host today means copying two compose files, writing a `.env`
by hand (eight secrets, several URLs and allowlists), logging in to the registry, and running
`docker compose` in the right order. Upgrading means editing `IMAGE_TAG`, pulling and restarting,
with no backup and no way back if the migration fails.

The operator turns both into one command each, run from a container:

```
docker run --rm -it -v /var/run/docker.sock:/var/run/docker.sock -v /opt/agile-copilot:/data \
  registry.gitlab.tech.orange/mohamedamine.belhajja/jira-agentic-ai/operator:<version> install
```

**Who uses it:** whoever runs the app on a machine inside the Orange network (a laptop, a team
server). **Success:** a fresh host goes from nothing to a healthy, reachable app in one `install`;
an `upgrade` either completes with every service healthy or leaves the previous version running
with its data intact.

## Decisions

| Topic | Decision |
|---|---|
| Kind | On-demand CLI in a container (not a long-running controller, not an in-app wizard) |
| Hosts | Inside the Orange network, pulling from `registry.gitlab.tech.orange` with a read-only deploy token |
| Implementation | TypeScript CLI in `apps/operator`, bundled with `scripts/bundle-node.mjs`, driving `docker compose` over the mounted socket |
| Stack definition | The repo's `docker-compose.selfhost.yml` and `docker-compose.server.yml`, embedded in the operator image of the same version; the operator never defines services itself |
| Versioning | `operator:<version>` installs and upgrades to app `<version>`; upgrading the app means running a newer operator |
| Out of scope | Automatic upgrades, a resident controller, offline bundles, a public registry, Kubernetes (the Helm chart covers it), configuring Jira/AI (done in the app's Settings) |

## Commands

All commands read and write only `/data` (the mounted host folder) and talk to Docker through the
socket. Every command is non-interactive when its answers are given as flags (`--yes` accepts the
defaults), so it can run from scripts.

### `install`

1. **Refuse** if `/data/operator.json` exists (an install is already there): point to `upgrade` or
   `config`.
2. **Ask** (or read from flags):
   - mode: `local` (published on `127.0.0.1:<port>`, default 3000) or `server` (Caddy with
     `APP_DOMAIN` and `ACME_EMAIL`, Let's Encrypt);
   - the public URL (local: `http://localhost:<port>`; server: `https://<domain>`);
   - optional: Data Center Jira hosts for `MCP_ALLOWED_URL_DOMAINS`, private hosts for
     `ALLOWED_PRIVATE_HOSTS`, SSO (`OIDC_*`), the registry deploy token (user + token).
3. **Validate** every answer before writing anything (URL shape, domain syntax, port range, host
   lists): nothing is written on a refused answer.
4. **Generate** the secrets with `crypto.randomBytes`: `POSTGRES_PASSWORD` and `APP_DB_PASSWORD`
   (hex, URL-safe as the compose file requires), `BETTER_AUTH_SECRET` (base64, 32 bytes),
   `ENCRYPTION_KEYS` (`v1:<base64 of 32 bytes>`).
5. **Write** `/data/compose/` (the embedded compose files), `/data/.env` (mode 0600) and
   `/data/operator.json`.
6. **Log in** to the registry when a token is given (`docker login --password-stdin`, the token
   never on a command line), pull the images of this version, `docker compose up -d`.
7. **Wait** for every service to report healthy (timeout 5 minutes), then print the URL and the
   next step (create the first account, then Settings → AI models and Jira).

On a failure after step 5, the containers are stopped and the error says which step failed; the
written files stay so a fixed `install --resume` can continue.

### `upgrade [--to <version>]`

Runs with the operator of the target version (the default and only supported `--to` is the
operator's own version; a mismatch is refused with the image to run instead).

1. **Check** the current install is healthy; refuse otherwise (`status` shows why).
2. **Back up** the database (`pg_dump` through `docker compose exec postgres`, custom format) into
   `/data/backups/<timestamp>-<from version>.dump`, and copy `.env` and `compose/` next to it.
3. **Pull** the new images (web, worker, migrate) before stopping anything: a failed pull changes
   nothing.
4. **Write** the new compose files, keeping the old ones in the backup folder.
5. **Stop** web and worker, **run** the new migrate one-shot, **start** the new web and worker.
6. **Wait** for health (5 minutes).
7. **Record** the new version and the upgrade in `operator.json`.

**Rollback** on any failure from step 4: put back the old compose files and `.env`, restore the
database from the step-2 backup when the migration had started (migrations are not reversible),
start the previous images, wait for health, and report what failed. The previous images are
still local, so a rollback needs no network.

### `status`

Installed version, mode and URL; each service's state and health; the last backup (date, size);
the last upgrade (from, to, result). Never prints a secret.

### `backup` / `restore <file>`

`backup` takes the same backup as an upgrade (database dump plus `.env` and `compose/`).
`restore` asks for confirmation (or `--yes`), stops web and worker, restores the dump into a fresh
database, puts back the `.env` from the same backup (its `ENCRYPTION_KEYS` decrypt the stored
credentials), starts the stack and waits for health. Backups older than the last 10 are deleted
after a successful backup.

### `config <key> <value>`

Changes one setting from a fixed list (the allowlists, the URL/domain, the port, SSO, the trusted
proxy hops, the skill-run limit), validates it like `install`, rewrites `.env`, and recreates only
the services that read it. Secrets are not changed here (rotating `ENCRYPTION_KEYS` stays a
documented manual procedure).

### `logs [service] [--follow]`

`docker compose logs` for the stack, with every value from `.env` replaced by `•••` before it is
printed.

## Architecture

```
apps/operator/
  src/main.ts          argument parsing, dispatch, exit codes
  src/settings.ts      the settings model: prompts, flag parsing, validation (pure)
  src/secrets.ts       secret generation (pure)
  src/env-file.ts      .env read/write, keeps unknown keys and comments (pure)
  src/state.ts         /data layout, operator.json
  src/docker.ts        the only module that runs docker / docker compose (spawn, no shell)
  src/commands/*.ts    install, upgrade, status, backup, restore, config, logs
  assets/              compose files copied in at image build time
```

- **Image:** a new final stage `operator` in `apps/web/Dockerfile` on the shared `runtime` base,
  plus the Docker CLI and the compose plugin (Alpine packages `docker-cli`,
  `docker-cli-compose`), the bundled `operator.mjs` and the compose files of the same commit. It
  runs as root inside the container: it needs the Docker socket, which is root-equivalent anyway;
  documented as such.
- **CI:** the docker template's image matrix gains `operator` (snapshot on every pipeline, release
  image with the others). The operator image's version is the release tag; snapshot builds use the
  branch slug, and `install --channel develop` maps to the snapshot images.
- **Image references:** the operator writes `WEB_IMAGE`, `WORKER_IMAGE`, `MIGRATE_IMAGE` (the
  variables `docker-compose.server.yml` already reads) and sets the same for local mode, so both
  modes pin the exact version instead of the compose defaults.
- **Compose project name:** fixed (`agile-copilot`) and written to `.env`
  (`COMPOSE_PROJECT_NAME`), so the stack is the same whether started by the operator or by hand.
- **Existing installs:** `adopt` is not part of this version. An existing hand-made install (like
  `D:\Projects\agile-copilot-server`) keeps working with plain `docker compose`; the README
  explains how to move it to an operator folder by copying `.env` (the secrets carry over).

## Safety

- Secrets come from `crypto.randomBytes`, are written only to `/data/.env` (0600) and to backups
  (0600), and are never printed, logged or passed as command-line arguments.
- Every Docker call goes through `docker.ts` with an argument array (no shell), so no value from
  a prompt or a file can inject a command.
- `restore` and any command that deletes data ask for confirmation unless `--yes` is given.
- The operator only touches the compose project it wrote; it never removes volumes except on
  `restore`, which recreates the database volume after confirmation.

## Testing

- **Unit (Vitest):** settings validation (each field's accepted and refused inputs), secret format
  and length, `.env` round trip (comments and unknown keys kept), the image references written
  per mode and version, the redaction used by `logs`, the upgrade step sequence and its rollback
  decisions (with `docker.ts` replaced by a recording fake).
- **Integration (Docker-enabled runner, like the database tests):** build two operator versions
  from the current tree with different tags; `install` the first into a temp folder, check health
  and the login page; `upgrade` to the second, check health and that data written before the
  upgrade (a user row) is still there; run an upgrade whose migrate image fails on purpose and
  check the rollback leaves the first version running with the same data; `backup` then
  `restore` and check the row comes back.
- **Manual before release:** a server-mode install on a VM with a real domain (the Let's Encrypt
  path cannot run in CI).

## Open points for the plan

- The exact Alpine package names and versions for the Docker CLI and compose plugin on Alpine
  3.24, and whether hadolint's pinning rule needs an ignore as for the runtime base.
- Whether CI should also publish an `operator:latest-develop` alias for convenience.
