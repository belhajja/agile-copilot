# Agile Copilot

Agile Copilot is a dashboard and AI agent for managers running Scrum or Kanban projects in Jira. It aims to give reliable, actionable insight (sprint health, flow, risks, forecasts) without analyst skills: you bring your own LLM key (BYOK), connect Jira (Cloud or Server/Data Center), and personalise the analysis by writing natural-language instructions. The UI is bilingual (English and French). This repository holds Phases 1 to 3: workspaces and roles, encrypted Jira and LLM connections, a background worker that syncs Jira boards, sprints and issue history, a deterministic metrics engine, default Scrum and Kanban dashboards that work without any LLM, and an assistant (chat) that answers from that data and proposes Jira changes you approve. See `docs/superpowers/specs/2026-10-03-agile-copilot-design.md` for the full design.

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

The assistant's live Jira tools for Data Center PATs and "Connect with Atlassian" connections go through [mcp-atlassian](https://github.com/sooperset/mcp-atlassian). To use them in development against a real Jira, start it (published on `127.0.0.1:4060` only) and point the app at it:

```bash
docker compose up -d mcp-atlassian
# in .env
MCP_ATLASSIAN_URL=http://127.0.0.1:4060/mcp
```

Without `MCP_ATLASSIAN_URL` the assistant still answers from synced data, and Cloud API-token connections keep their live Jira tools (built in). mcp-atlassian refuses `localhost` and IP-literal Jira URLs, so it cannot reach a Jira on your machine by IP; without a real Jira, use the double started by `pnpm --filter @agile/e2e mocks` (`MCP_ATLASSIAN_URL=http://127.0.0.1:4050/mcp`).

## Self-hosting

`docker-compose.selfhost.yml` runs Postgres, a one-shot `migrate` service, the web app, the sync worker, and mcp-atlassian (`mcp-atlassian`, the assistant's live Jira tools, and a read-only twin `mcp-atlassian-readonly`). Neither mcp-atlassian service is published: only the web app reaches them, inside the compose network.

```bash
cp .env.example .env
# fill BETTER_AUTH_SECRET, ENCRYPTION_KEYS (v1:<base64>), POSTGRES_PASSWORD, APP_DB_PASSWORD
# (paste generated values; .env does not run $(...). Use `openssl rand -hex 24` for the two passwords)
# set BETTER_AUTH_URL to the public URL of the app
docker compose -f docker-compose.selfhost.yml up -d --build
```

The `migrate` service connects as the database owner and must exit 0 before `web` and `worker` start; both connect as the non-owner `app_user` role so row-level security applies. `web` and `worker` receive an explicit list of variables from `.env` (never `POSTGRES_PASSWORD` or an owner connection URL). The worker has no published port; its health endpoint (`/health`, port 8080 on `0.0.0.0` inside the container) is used by the container health check, and its `stop_grace_period` is 200 s: on stop it interrupts running syncs at their next page (they are recorded as *interrupted* and retried) and running skill runs (recorded as *interrupted*, deliveries cut off), then waits up to 190 s for jobs to record their outcome (plus a 195 s backstop) before exiting. On Kubernetes, set `terminationGracePeriodSeconds: 200`. The app is published on `${WEB_PORT:-3000}`; if you change it, update `BETTER_AUTH_URL` to match. Put a TLS-terminating reverse proxy in front of it for anything beyond a local trial.

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

1. In **Settings → Jira**, open a connection's **Boards**, load the boards, and select the ones to sync. Loading only lists the boards; each board's configuration (columns, estimation field) is read when you select it, and again at every sync.
2. Check the **status mapping** of each board. Every Jira status counts as *To do*, *In progress* or *Done* (suggested from Jira's status categories). Mark in-progress statuses where work only waits (for example *Blocked* or *Waiting for review*): flow efficiency counts that time as waiting.
3. Click **Sync now**, or wait for the scheduled sync (every `SYNC_INTERVAL_MINUTES`, default 15). Each board keeps its own progress: its first sync reads all its issues; later syncs read only issues updated since that board's previous successful sync (with a 15-minute overlap), and once a day each board is re-read completely so that issues which left it disappear from it. A board that fails (for example its saved filter was deleted) shows the reason on its row and does not hold back the other boards.
4. Open the board from the home page. Boards with sprints (Scrum boards, and team-managed boards whose project uses sprints) get a *Sprint* and a *Flow* dashboard; the others a *Flow* dashboard. Boards that estimate with time tracking (hours) are counted in issues, not points.

How the numbers are defined:

- **Velocity**: *committed* is what was in the sprint when it started (estimates as of the start); *completed* is what was done when it closed (estimates as of the close), including work added mid-sprint. Boards without an estimation field use issue counts.
- **Cycle time** runs from the first move to an in-progress status to the final move to done; **lead time** from creation to done. Percentiles use the nearest-rank method.
- **Flow efficiency** is the share of cycle time not spent in a *waiting* status or flagged as an impediment.
- **Forecasts** are Monte Carlo simulations (10 000 runs, fixed seed) drawn from the last 30 days of daily throughput.
- Days are UTC calendar days. Sub-tasks are left out (as in Jira's own reports).

The sync never stores raw Jira error messages: a failed sync shows a short reason (for example *Jira rejected the stored credentials*). What happens next depends on the reason:

- **Retryable** (`rate_limited`, `unreachable` — including a DNS failure — and `interrupted`, when the worker stopped mid-sync): the job is retried with backoff (twice), and the scheduled sync keeps running.
- **Board problems** (`board_query_rejected`, the board's filter was rejected by Jira; `board_not_found`; `jira_paging`; …): the other boards keep syncing; the failing board is tried again at every scheduled sync and its row shows the reason until it succeeds.
- **Permanent** (`unauthorized`, `forbidden`, `oauth_expired`, `oauth_unavailable`, `blocked_url`): only a person can fix these, so the scheduled sync skips the connection. Fix the cause (update the token, **Reconnect with Atlassian**, ask the administrator to allow the host), then **Retest** the connection or reconnect — a successful retest or reconnect clears the error — or click **Sync now**.

## Assistant

**Assistant** (sidebar) is a chat that uses the workspace's default AI model (Settings → AI model).

- **Numbers come from the metrics engine.** The assistant calls an internal analytics MCP server (`packages/analytics-mcp`: `list_boards`, `list_metrics`, `get_metric`, `forecast`, `find_issues`, `explain_metric`) that computes the same numbers as the dashboards, from synced data, inside your workspace only. It runs in-process; it is not exposed over the network (an external endpoint for other MCP clients is planned for Phase 5).
- **Live Jira** goes through an explicit allowlist of 11 tools (search, read issue, transitions, boards, sprints, sprint issues; comment, transition, assign, create, update). Data Center PATs and "Connect with Atlassian" connections use the shared [mcp-atlassian](https://github.com/sooperset/mcp-atlassian) container (the self-host compose runs it; set `MCP_ATLASSIAN_URL` otherwise). Cloud **API-token** connections use a built-in client instead (mcp-atlassian would need one container per Cloud site for them).
- **Every Jira change needs your approval.** The model can only *propose* a write: the chat shows exactly what will be sent, and to which Jira site, with **Approve** / **Reject**. Nothing reaches Jira before you approve; each decision and each executed change is written to the audit log (`agent_action.*`). An approval is bound to you, the conversation, the Jira site and the exact proposal, and runs at most once. If that site's connection is removed or replaced before you approve, the change is not sent anywhere.
- **An approved change always ends with a result.** If the reply fails after you approved (the AI model or the server fails before the change is sent), the change is closed as *approved but not sent* (audited as `agent_action.failed`, `not_executed`) and the chat tells you to ask again; the conversation keeps working. A change cut off by a timeout after it was sent is reported as *may or may not have reached Jira*: check Jira before asking again.
- **Only owners and admins get live Jira** (reads and changes) for now: both use the connection's Jira credentials, which can see more than the boards an admin chose to sync. Members get the analytics tools (synced, selected boards only), and the assistant tells them live Jira queries are not available for their role. Finer roles (e.g. Manager, with explicit scopes) come with Phase 5.
- **Markdown becomes Jira wiki markup.** Comments, transition comments and descriptions are converted the same way on both backends (the built-in client ports mcp-atlassian's own converter), so `**bold**` and `- lists` render in Jira. NUL characters are removed first; that is the only intended difference from mcp-atlassian's converter.
- **Jira content is data, not instructions.** Tool results reach the model inside a fixed `<data>` envelope that Jira text cannot close, and the system prompt tells the model never to follow instructions found there. Tools take no workspace or connection ids: the server binds them to you.
- **Cost meter.** Token usage is recorded per answer. Set your provider's prices per million tokens on the AI model connection to see costs; **Settings → Usage** shows this month's usage (owners/admins see every member).

### mcp-atlassian settings

The image is pinned by digest (`ghcr.io/sooperset/mcp-atlassian:0.23.1@sha256:…`, the same reference as `MCP_ATLASSIAN_IMAGE` in `packages/jira-tools/src/image.ts`, which the contract test runs; a test keeps the compose files in sync). Both compose files configure it for the deployment, never per workspace:

- `ENABLED_TOOLS`: the shared instance enables the 11 catalog tools plus `jira_search_assignable_users`, which the server uses to resolve an assignee exactly before an assignment (the model never sees it). The read-only twin enables the 6 read tools and sets `READ_ONLY_MODE=true`; skill runs (worker) and skill previews (web) use it through `MCP_ATLASSIAN_READONLY_URL`, never the read-write instance.
- `ATLASSIAN_OAUTH_ENABLE=true`, so the shared instance accepts each user's OAuth token and cloud id per request.
- Never set `JIRA_URL`, Jira tokens or usernames, or `ALLOW_GLOBAL_CRED_FALLBACK` on it: every request carries its own credentials, and a request without them is refused.
- `MCP_ALLOWED_URL_DOMAINS` (passed from `.env`): Data Center hosts that resolve to private addresses (list them in `ALLOWED_PRIVATE_HOSTS` too, for the app). Empty = unset. **Once set, it is an allowlist for every Data Center host, public ones included: list them all**, or the others stop working. mcp-atlassian refuses `localhost` and IP-literal URLs even when listed.
- Each self-host mcp-atlassian container is capped at `mem_limit: 512m`; raise it in the compose file if it is killed under load.
- The web app does not wait for mcp-atlassian (`depends_on` is `migrate` only): if the sidecar is down or its image cannot be pulled, the app and dashboards still work, and the assistant's Jira tools for Data Center PATs and "Connect with Atlassian" answer *unavailable* until it is back.
- The self-host compose puts mcp-atlassian on its own `mcp` network, shared only with the web app: it cannot reach Postgres or the worker (its own outbound check, `MCP_ALLOWED_URL_DOMAINS`, is not DNS-pinned like the app's). The read-only twin has its own `mcp-readonly` network, shared with the web app and the worker (skill runs): the worker can reach the twin, never the read-write instance. The app never follows a redirect from `MCP_ATLASSIAN_URL`.
- `MCP_ATLASSIAN_URL` (web app) is a trusted deployment setting: the app sends users' Jira tokens to it. Point it only at your own internal service (`http://mcp-atlassian:8000/mcp` in the self-host compose, which sets it for you); never publish mcp-atlassian outside the compose network.

### Checking AI providers and Jira through the assistant by hand

Automated tests cover tool calling, streaming, approvals and usage against an OpenAI-compatible mock, check that every provider adapter (Anthropic, OpenAI, Google, Mistral, Azure OpenAI, OpenAI-compatible) accepts the assistant's tool definitions, and run all 11 Jira tools through the real mcp-atlassian image against a mock Data Center Jira. What they cannot cover needs real keys and real Jira sites. Before a release, and whenever a provider SDK or the mcp-atlassian image is upgraded, run this:

1. **Providers.** For each of Anthropic, OpenAI, Google Gemini, Azure OpenAI and Ollama (OpenAI-compatible, a tool-capable model such as `llama3.1`): add the connection, make it the default, open **Assistant**.
   - Ask "What is our velocity?" on a synced Scrum board: the answer quotes the dashboard's number and the chat shows the `get_metric` call.
   - Ask "Comment on <ISSUE-KEY>: test from the assistant": an approval card appears and Jira is unchanged; **Reject** → nothing is written; ask again and **Approve** → the comment appears in Jira once.
   - **Settings → Usage** shows the answers with non-zero tokens (and a cost once prices are set).
   - Ollama and other OpenAI-compatible servers: propose two changes in one conversation (reject the first, approve the second). Some local servers reuse tool call ids across turns; both proposals must appear in the audit log (`agent_action.proposed` twice) and only the approved one may reach Jira.
2. **Cloud OAuth through mcp-atlassian.** With an Atlassian OAuth app configured, "Connect with Atlassian" to a Cloud site and repeat step 1 on it. The contract test only proves that mcp-atlassian accepts the bearer token and cloud id; also check:
   - Jira receives the calls (through `api.atlassian.com/ex/jira/<cloudId>`) as the connected user;
   - a search on more than one page of results: Cloud returns no total (`total: -1`, `next_page_token`), so the assistant should still see that more results exist;
   - "Assign <ISSUE-KEY> to <name>": the exact-match assignee lookup (`query=`) and the assignment by `accountId`;
   - create an issue with a Markdown description and update one: mcp-atlassian writes Cloud descriptions as ADF (REST v3), so check that bold text and lists render.
3. **Data Center PAT through mcp-atlassian.** Connect a Data Center site with a personal access token (a private host needs both `ALLOWED_PRIVATE_HOSTS` and `MCP_ALLOWED_URL_DOMAINS`) and run all 11 tools once: search, read issue, transitions, boards, sprints, sprint issues, then approve a comment, a transition, an assignment, a create and an update.
4. **Latency.** Note how long a Jira tool call takes on each path (mcp-atlassian builds a Jira client per request and calls `/myself` before each call; the built-in client for Cloud API tokens does not). If it hurts, the spec's fallback is a per-site instance.
5. **Transitions.** On the mcp-atlassian path the target status of a transition (`to`) is `null` (mcp-atlassian 0.23.1 does not return it against Jira); check that the model still picks the right transition by name, and record whether a real Jira returns it.
6. **Updates really change Jira.** Update an issue's summary, description and labels and check each one in Jira. mcp-atlassian silently drops any field that Jira's `/field` does not list and still reports success; this is harmless for these system fields, but **any field added to the tool catalog later (custom fields in particular) must be checked here**.
7. **Members.** As a workspace member (not owner/admin), ask for a comment and for a live Jira search: no approval card appears, no `jira_*` tool is called, and the assistant says live Jira is not available for the role (metric questions still work).
8. **Markdown.** Comment `Blocked by the **API** team:` followed by a ``- `npm ci` fails`` list item on a Cloud API-token connection (built-in client) and on a Data Center connection (mcp-atlassian): both render the same in Jira (bold, bullet, monospace).
9. Record provider, model, Jira version, date and results below and in the pull request.

Record results here (**NOT YET RUN**: no provider API keys, Atlassian OAuth app, Jira Cloud sandbox or Data Center licence were available when this was written; nothing below has been checked live):

| Date | Check | Provider / model or Jira (deployment, version) | Result | Notes (latency, …) | Checked by |
| ---- | ----- | ---------------------------------------------- | ------ | ------------------ | ---------- |
| —    | 1. Anthropic tool calling + approvals | — | NOT YET RUN | | |
| —    | 1. OpenAI tool calling + approvals | — | NOT YET RUN | | |
| —    | 1. Google Gemini tool calling + approvals | — | NOT YET RUN | | |
| —    | 1. Azure OpenAI tool calling + approvals | — | NOT YET RUN | | |
| —    | 1. Ollama tool calling + approvals | — | NOT YET RUN | | |
| —    | 2. Cloud OAuth through mcp-atlassian | Cloud — | NOT YET RUN | | |
| —    | 3. Data Center PAT through mcp-atlassian | Data Center — | NOT YET RUN | | |
| —    | 4. Per-request latency | — | NOT YET RUN | | |
| —    | 5. Transitions `to` on the mcp-atlassian path | — | NOT YET RUN | | |
| —    | 6. Updates change Jira (no silently dropped fields) | — | NOT YET RUN | | |
| —    | 7. Members get no live Jira tools | — | NOT YET RUN | | |
| —    | 8. Markdown → wiki markup on both backends | — | NOT YET RUN | | |

## Skills

**Skills** (sidebar) are saved instructions for the assistant, written as a `SKILL.md` document (YAML settings between `---` lines, then Markdown instructions):

```markdown
---
name: monday-risks
description: Stories at risk for the sprint goal, every Monday
trigger: schedule          # on_demand | always | schedule | alert
schedule:
  cron: "0 8 * * 1"         # 5 fields, at most hourly
  timezone: Europe/Paris
output: email              # chat | dashboard_card | email | slack | teams
---

1. Call list_boards. 2. For each Scrum board, check the sprint burndown and list the stories at risk.
```

- **On demand.** The assistant sees the names and descriptions of your skills and of the built-in library as data, and loads a skill's full text with `load_skill` when your question matches it. Skill text reaches the model as your own instructions inside a fixed `<skill>` envelope, never in the system prompt.
- **Always (preferences).** Your enabled `always` skills (e.g. "answer in French, never name individuals") are added to every conversation and to every run of your skills.
- **Schedule.** Runs once per scheduled time (5-field cron, at most hourly, in the skill's time zone), never for times before the skill was saved, and skips a time missed by more than an hour (no catch-up burst after an outage).
- **Alert.** Compares one KPI metric with a number on each board in scope (`alert: { metric: wip, op: ">", value: 10 }`, `op` one of `>`, `>=`, `<`, `<=`), without any AI call. The skill runs when a board starts matching, at most once every 12 hours.
- **Outputs.** On-demand and `always` skills answer in the chat. For background runs: `chat` keeps the report on the skill's page, `dashboard_card` shows it as an insight card on your board dashboards, and `email`, `slack` and `teams` are delivered (see Delivery). `scope` lists board ids.
- **Built-in library.** Nine editable templates: sprint health check, daily stand-up brief, retro prep, stale/aging work, scope-creep watcher, delivery forecast, blocker report, Kanban flow review, team workload balance. Copy one to make it yours; while any copy of a built-in exists (enabled or not) the stock entry is hidden, so delete the copy to get it back.
- **Versions.** Every save is a new version and any older version can be restored. Two tabs cannot overwrite each other.
- **Who can do what.** Any member can create skills. Only a skill's owner edits it. The owner can **share** it with the workspace (others can read and copy it) or make it private again. An owner or admin can delete a *shared* skill (moderation); a private skill is deleted only by its owner.
- **Copying.** A shared skill never reaches another member's assistant until they copy it, and you copy only from the skill's own page, where its text is visible. A copy is a snapshot (later edits of the original do not reach it) and **starts disabled**: read it, then enable it.

### Background runs

- **Read-only.** A scheduled, alert or **Run now** run (and a builder preview) has no write tool. It offers the analytics tools and, for owners and admins, the Jira *read* tools through the read-only mcp-atlassian twin (`MCP_ATLASSIAN_READONLY_URL`; where it is unset, runs use synced data only). A report recommends actions; changes stay in the chat, under approval.
- **Whose permissions.** A run executes as the skill's owner with the owner's *current* role. **Members get the analytics tools only** (synced, selected boards), as in the chat.
- **Slack and Teams outputs are for owners and admins only**, until Phase 5 roles: checked when the skill is saved and again at run time (a run whose owner no longer qualifies fails with `forbidden_role`).
- **Run outputs are private to the owner.** Other members and admins see that a run happened and one status for it (*Done*, *Failed*, *Skipped* with its reason), never its report or delivery detail, even on a shared skill.
- **Limits per run:** 6 model steps, 2,000 output tokens, 120 seconds, and **no automatic retries** (each attempt costs a model call; a failed run is shown to the owner). Alerts are evaluated without any model call.
- **`SKILL_RUNS_DAILY_LIMIT`** (default 50): runs per workspace per rolling 24 hours. Over it, a run is recorded as `skipped` with `daily_limit`. `0` disables skill runs. Previews and drafts are metered on **Settings → Usage** (shown apart from chat answers) but do not count against this limit.
- **Fair share of the daily limit.** So that one member cannot use up everyone's day: the runs of one owner's skills (schedules, alerts and **Run now** together) may use at most half of the limit, and never fewer than 5 runs (`max(5, ceil(limit / 2))`; 25 of the default 50), beyond which their runs are skipped with `owner_limit`; and each user may press **Run now** at most **10 times per rolling 24 hours** (`user_limit`). Runs that ended before any model call (skipped runs, a refused Slack/Teams owner `forbidden_role`, an invalid skill, no AI model) count toward none of these limits. Limits are checked under one lock per workspace, so concurrent ticks and clicks cannot exceed them.
- **Run now** is offered on the owner's enabled scheduled and alert skills only: turn a skill on first (copies start off).
- **Background model.** Runs use the workspace's background model (Settings → AI model → *Use for skill runs*), falling back to the default model.
- **Owner left.** If the owner is no longer a member of the workspace, the skill is auto-disabled (audited, with one skipped run recorded as `owner_left`) instead of running.
- **Snapshot delivery.** The output kind and channel (the Slack/Teams channel, or for email the workspace's SMTP server) are copied into the run when it is planned, and the run is delivered from that snapshot: editing the skill or the channels during a run cannot redirect it.
- **Delivery outcome.** A report that went out is recorded as sent even if the database fails right afterwards. When the worker stops during a delivery, the delivery is cut off and the run ends as `interrupted` (with its report), never left running.
- **The queue.** The worker (pg-boss, `pgboss` schema) runs a scheduler tick every 5 minutes that plans due schedules and alerts; each run is one job (one job per run id, no job retries, 10-minute expiry). **Run now** in the web app queues a job for the worker; the web app never runs a background run itself, so the worker must be running. A run still `queued` after 10 minutes is queued again, and one queued or running for 30 minutes (e.g. a crashed worker) is closed as failed (`interrupted`).

### Skill builder

Describe the skill in your words, **Draft with AI**, edit the `SKILL.md`, **Preview on real data** (one read-only run as you, nothing delivered), then **Save**. The draft comes from a forced `propose_skill` tool call that the server validates and turns into the document (the model never writes the YAML); an invalid proposal falls back to an on-demand chat skill. **Drafts are never saved automatically**: review before saving, since a draft built from Jira text is stored text that will later run. Each user may make **20 drafts or previews per hour**; a slot is reserved before the model is called, so a burst cannot exceed it.

### Delivery

Configure channels at **Settings → Delivery** (owners and admins). Each channel is tested when saved; URLs and passwords are encrypted and never shown again.

- **Email (SMTP).** One SMTP channel per workspace (Nodemailer, React Email template). The host is resolved once and the connection is **pinned** to the address that passed the outbound check. Security is `starttls` (STARTTLS **required**, no downgrade), `tls` (implicit TLS) or `none`; TLS 1.2 or later. **Plaintext (`none`) only to hosts in `ALLOWED_PRIVATE_HOSTS`**, checked again on every send (`insecure_transport`). Mail goes to the skill owner's account address only, as plain text with nothing remote loaded; subject, footer and link follow the owner's UI language at the last save.
- **Slack and Teams.** Incoming webhooks. Text is escaped (Slack control characters; Markdown link and image syntax for Teams) so model output built from Jira text cannot ping or link, Slack unfurling is off, and the link back to the app is plain text. A plain `http://` webhook is accepted only for `ALLOWED_PRIVATE_HOSTS`. Owner/admin skills only (above).
- **Channel usage.** The Delivery page lists, for each channel, the skills that use it. Deleting a channel keeps the run history.
- **Dev.** `docker compose up -d mailpit` runs a mail catcher (SMTP 127.0.0.1:1025, web UI http://127.0.0.1:8025). Add it as an SMTP channel with security `none` and list `127.0.0.1` in `ALLOWED_PRIVATE_HOSTS`. `docker compose up -d mcp-atlassian-readonly` runs the read-only twin on 4061 (`MCP_ATLASSIAN_READONLY_URL=http://127.0.0.1:4061/mcp`).

### Pinned charts from the chat

Ask "pin the cycle time for DEMO Scrum": the assistant adds a widget from the dashboard catalog (a validated spec, never code) to the **Pinned** tab of that board. It is your own dashboard, so there is no approval; the action is audited as `dashboard.widget_pinned` and removable with one click (on the Pinned tab only). A dashboard holds **at most 40 charts**; beyond that the pin is refused (`dashboard_full`).

### Skills operations

- **Networks (self-host compose).** `mcp` holds the read-write mcp-atlassian and the **web app only**. `mcp-readonly` holds the read-only twin and is shared by the **web app (previews) and the worker (runs)**: the worker can reach the twin and never the read-write instance. Neither is published.
- **Settings.** The self-host compose sets `MCP_ATLASSIAN_READONLY_URL` (`http://mcp-atlassian-readonly:8000/mcp`) and `SKILL_RUNS_DAILY_LIMIT` for web and worker; both are in `.env.example`.
- **The twin** runs the same pinned image with the six read tools and `READ_ONLY_MODE=true`.

### Checking delivery by hand

The tests use an SMTP mock, a webhook receiver and (in Vitest) a real Mailpit. Before relying on delivery, run these once against real services:

1. **SMTP.** Add your provider's SMTP with `starttls` (then `tls`), a skill with `output: email`, **Run now**: the mail arrives at the owner's address as plain text with no remote content. `none` towards a public host is refused.
2. **Slack.** Add an incoming webhook and an admin-owned skill with `output: slack`, **Run now**: the post appears, links are not unfurled, and Jira text containing `@here` or `<!channel>` notifies nobody.
3. **Teams.** The same with a Teams webhook: the card renders and `[text](url)` in Jira text is not a link.
4. **Read-only runs on real Jira.** A scheduled skill owned by an admin on a Data Center PAT connection and on a Cloud OAuth connection reads Jira through the twin; a member's skill gets analytics only.

Record results here (**NOT YET RUN**: no SMTP provider, Slack or Teams workspace or real Jira was available when this was written; nothing below has been checked live):

| Date | Check | Provider / service | Result | Notes | Checked by |
| ---- | ----- | ------------------ | ------ | ----- | ---------- |
| —    | 1. Live SMTP (STARTTLS and TLS) | — | NOT YET RUN | | |
| —    | 2. Live Slack webhook | — | NOT YET RUN | | |
| —    | 3. Live Teams webhook | — | NOT YET RUN | | |
| —    | 4. Read-only runs through the twin on real Jira | — | NOT YET RUN | | |

## Validating against a real Jira

Automated tests run the same contract against a Cloud-flavoured and a Data Center-flavoured mock Jira (REST v3/`search/jql` with page tokens, REST v2/`search` with offsets, the Agile API, truncated changelogs and HTTP 429). Before relying on a new Jira version, run this checklist once against a real site (a [Data Center trial container](https://hub.docker.com/r/atlassian/jira-software) with a time-bombed licence, and a Jira Cloud sandbox):

1. Connect it (Cloud: API token and "Connect with Atlassian"; Data Center: personal access token). Self-hosted Data Center needs its host in `ALLOWED_PRIVATE_HOSTS`.
2. Load boards: every Scrum, Kanban and team-managed board you can see in Jira is listed, with the right type. After selecting them, Scrum boards that estimate in story points show "Story points".
3. Status mapping: every column status appears, with a sensible suggestion.
4. Select one Scrum and one Kanban board and click **Sync now**. In Jira, run the board's filter (`filter = <id>` in issue search): the number of issues matches the board's dashboards' data, and the closed sprints match the sprint report's committed/completed values for a sprint with no mid-sprint estimate changes.
5. Move an issue to another status in Jira, wait for the next scheduled sync (or click **Sync now**), and check that cycle time / WIP change accordingly.
6. With a board of more than 100 issues, check that all of them were read (pagination) and that an issue with more than 100 changelog entries has its full history.
7. Note the Jira version and the date in the pull request that validated it, and record the results below.

Record results here (**NOT YET RUN**: no Jira Data Center licence or Cloud sandbox was available when this was written; nothing below has been checked against a real Jira):

| Date | Jira (deployment, version) | Steps 1–6 result | Notes | Checked by |
| ---- | -------------------------- | ---------------- | ----- | ---------- |
| —    | Data Center —              | NOT YET RUN      |       |            |
| —    | Cloud —                    | NOT YET RUN      |       |            |

## Rotating the encryption key

`ENCRYPTION_KEYS` is a comma-separated list of versioned 32-byte keys. To rotate, append `v2:<new base64 key>` and restart. New organisation keys are wrapped with v2; existing ones still decrypt with v1, so keep v1 in the list. A re-wrap command to retire old versions is not available yet (planned for Phase 5).

## Security model

- Row-level security in Postgres as a second guard behind application checks; the app runs as the non-owner `app_user`, which cannot update or delete the audit log.
- Secrets (Jira tokens, LLM API keys) are encrypted with AES-256-GCM using a per-organisation data key, itself wrapped by the key-encryption key from `ENCRYPTION_KEYS`. Secrets never go to the browser.
- Every connection change is written to an audit log.
- Connections are tested before they are saved (Jira reachability; LLM tool-calling support).
- An outbound URL guard blocks requests to private, loopback and link-local addresses unless the host is in `ALLOWED_PRIVATE_HOSTS`. Requests to user-supplied hosts (Jira, OpenAI-compatible model URLs) connect only to the address that passed this check, resolved once at connect time, so DNS rebinding cannot redirect them.
- The assistant never writes to Jira without the user's explicit approval of that exact change. Skill runs have no write tools at all.
- Skills written by other members never reach your assistant unless you copy them (they start disabled); skill emails go only to the skill owner's own address; Slack/Teams posts are escaped and not unfurled.

### Known limitations

- mcp-atlassian applies its own outbound rules (`MCP_ALLOWED_URL_DOMAINS`), separate from `ALLOWED_PRIVATE_HOSTS`.
- Approval cards show the proposed values, not a before/after diff of the Jira fields.
- Only workspace owners and admins get live Jira through the assistant (reads and changes) until Phase 5 roles; members use the analytics tools.
- Assignees: the built-in client (Cloud API tokens) skips deactivated people and Cloud app/customer accounts; mcp-atlassian 0.23.1 does not report those fields, so on its path the exact-name match relies on Jira's assignable-user search (active users who can be assigned the issue).
- Skill email goes to the skill owner's account address, which is not verified yet (P4-R9). The run uses the owner's role and members get analytics only, so a member can only email themselves data they can already see; an admin with a mistyped or compromised address receives reports. Phase 5 SSO (IdP-verified email) closes this.
- There is no hard allowlist of Slack/Teams webhook hosts (P4-R26): an admin can point a channel at any public https receiver (plain http only for `ALLOWED_PRIVATE_HOSTS`). A `WEBHOOK_ALLOWED_HOSTS` option is a Phase 5 candidate.
- Accepted residual: Jira text injected into a chat can make the model pin a chart (own dashboard, audited, capped at 40, removable); it cannot write to Jira.
- Skill emails go to the skill owner only (no other recipients yet); Slack and Teams channels serve teams.
- Slack/Teams outputs need an owner/admin skill owner until Phase 5 roles.
- A workspace-wide preference set by an admin for everyone does not exist yet: each member adds (or copies) their own `always` skills.
- The `SKILL_RUNS_DAILY_LIMIT` caps a count, not money: an expensive model can still cost more per run (admins see spend on Usage).
- The key-rotation re-wrap command does not exist yet (Phase 5).

## Development

```bash
pnpm test        # unit and integration tests (Vitest; needs Docker for Testcontainers)
pnpm e2e         # Playwright end-to-end tests (needs the dev Postgres from `docker compose up -d postgres`)
pnpm lint        # Biome
pnpm typecheck
```

Docker is required for tests because the database tests start Postgres through Testcontainers. The e2e suite runs the web app on port 3200 and the sync worker (health on 4030) against Postgres on 5433, with local mock Jira (4010, serving a demo dataset), LLM (4020, a scripted tool-calling model) mcp-atlassian (4050, a double with the same tools that writes to the mock Jira; it also stands in for the read-only twin at `http://127.0.0.1:4050/readonly/mcp`), plus an SMTP mock (4070) and a Slack/Teams webhook receiver (4080) for skill delivery. `pnpm test` also runs a contract test against the real `ghcr.io/sooperset/mcp-atlassian` image (pulled by Testcontainers). The dev compose's mcp-atlassian uses 4060, its read-only twin 4061 and Mailpit 1025/8025. `pnpm test` also runs an email contract test against the real Mailpit image. The first visit of each page makes `next dev` compile it; if a cold run times out, run it again (CI uses longer timeouts: `CI=true pnpm e2e`).
