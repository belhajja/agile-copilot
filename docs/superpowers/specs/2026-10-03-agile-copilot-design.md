# Agile/Kanban Copilot — Design Spec

_Status: draft for review · 2026-10-03_

## Context
Managers running Scrum or Kanban projects in Jira struggle to get reliable, actionable insight (sprint health, flow, risks, forecasts) without analyst skills. The product is a SaaS dashboard + AI agent: the user brings their own LLM key (BYOK), connects Jira (via MCP), and personalises analysis purely by writing natural-language "skills" (instructions/preferences). Target users are non-technical. Code must be production-grade and reuse open source wherever possible.

The project folder (`/Users/mbelhajja/Desktop/Projects/Jira-Agentic-IA`) is empty — greenfield.

### Decisions already made (with the user)
| Topic | Decision |
|---|---|
| Jira | Cloud **and** Server/Data Center |
| Deployment | Hosted multi-tenant SaaS **+** self-host option (same codebase, Docker Compose) |
| LLM BYOK | Any provider through one abstraction (Anthropic, OpenAI, Gemini, Azure OpenAI, Mistral, Ollama/OpenAI-compatible) |
| Stack | TypeScript full-stack |
| Jira writes | Read freely; writes are *proposed actions* the manager approves in one click; audit-logged |
| Architecture | **Hybrid**: synced data + deterministic metrics engine + LLM agent using Jira MCP and an internal analytics MCP |

---

## Architecture

```
            ┌──────────────────── apps/web (Next.js) ─────────────────────┐
 Browser ──▶│ Dashboard (widgets) │ Agent chat │ Skills studio │ Settings │
            └───────┬───────────────────┬───────────────────────────┬─────┘
                    │                   │ Vercel AI SDK (BYOK)      │
                    │                   ▼                           │
                    │        Agent runtime (packages/agent)         │
                    │          │ MCP client          │ MCP client   │
                    │          ▼                     ▼              │
                    │   mcp-atlassian         analytics MCP          │
                    │   (sidecar, OSS)        (packages/analytics-mcp)
                    │          │                     │              │
                    ▼          ▼                     ▼              ▼
              Postgres (Drizzle, RLS by org)  ◀── apps/worker (pg-boss):
                                                   Jira sync · metrics · scheduled skills · digests
```

### Open-source building blocks (don't reinvent)
- **Monorepo:** pnpm workspaces + Turborepo
- **Web/UI:** Next.js (App Router), Tailwind, shadcn/ui, shadcn charts (Recharts), Vercel **AI Elements** / `useChat` for streaming chat
- **Auth & tenants:** **better-auth** with the organization plugin (workspaces, roles, invites). No social logins (Apple/Google). Roadmap:
  1. **Phase 1:** email + password for everyone.
  2. **Later (SSO phase):** users sign in through an external identity provider — **Keycloak** first (better-auth `genericOAuth` ships a Keycloak provider), any OIDC IdP (Authentik, Zitadel, Entra ID, Okta) via the same plugin; per-customer IdPs in SaaS via `@better-auth/sso`. Email/password is then restricted to the platform admin account(s) (break-glass), controlled by config (`PASSWORD_LOGIN=admin_only`); sign-up page removed when SSO is on (users are provisioned on first SSO login or invited).
- **DB:** Postgres + **Drizzle ORM**; `org_id` on every tenant table + Postgres Row-Level Security as a second guard
- **Jobs/scheduling:** **pg-boss** (Postgres-backed queue + cron → no Redis, so self-hosting stays simple)
- **LLM abstraction:** **Vercel AI SDK** provider registry (Anthropic, OpenAI, Google, Azure, Mistral, OpenAI-compatible/Ollama), with its MCP client and tool-approval flow
- **Jira MCP:** **sooperset/mcp-atlassian** (Docker sidecar, streamable HTTP, per-request credentials — see *Jira auth & MCP topology* below); the official Atlassian Remote MCP can be added later as an alternative Cloud OAuth option
- **Jira bulk sync:** **jira.js** (REST v2/v3 + Agile API; incremental via `updated >= lastSync`, with changelogs)
- **Internal MCP:** `@modelcontextprotocol/sdk` (also lets customers plug our analytics into Claude Desktop/ChatGPT later)
- **Validation:** zod everywhere (env, API, widget specs, skill files)
- **LLM observability/cost:** **Langfuse** (self-hostable); OpenTelemetry; Sentry optional
- **Email:** React Email + Nodemailer (SMTP, works self-hosted) / Resend for SaaS
- **Testing:** Vitest, Playwright, **promptfoo** for agent/skill evals
- **Packaging:** Docker images + `docker-compose.yml` (web, worker, mcp-atlassian, postgres, optional langfuse/ollama)

### Monorepo layout
```
apps/web            Next.js app (UI + API routes + agent streaming endpoint)
apps/worker         pg-boss workers: sync, metrics, scheduled skills, digests
packages/db         Drizzle schema, migrations, RLS policies
packages/auth       better-auth config
packages/crypto     envelope encryption for secrets (AES-256-GCM, per-org DEK, KEK from env/KMS)
packages/jira       jira.js wrapper: connection test, incremental sync, Cloud/DC normalisation
packages/metrics    pure, deterministic metric functions (heavily unit-tested)
packages/analytics-mcp  MCP server exposing metrics/query tools (tenant-scoped)
packages/agent      model registry (BYOK), system prompt, skill loader, tool wiring, approvals
packages/skills     skill schema (SKILL.md-style frontmatter), built-in library
packages/ui         shared shadcn components + widget renderers
```

---

## Core components

### 1. Connections (onboarding in < 5 min)
- **Jira:** URL + type autodetect (Cloud vs DC) → **Cloud: "Connect with Atlassian" (OAuth 2.0 3LO, default) or email + API token (fallback)**; **DC: PAT** → "Test connection" → pick boards/projects. Map workflow statuses to *To Do / In Progress / Done* categories (auto-suggested from Jira status categories, editable) — needed for correct flow metrics.
- **LLM:** pick provider + paste key (+ base URL/deployment for Azure/Ollama) → validated with a tiny tool-calling probe. Keys encrypted at rest, never sent to the browser, decrypted only in the server process at call time.
- Per-org default model + optional "cheap model" for background digests.

#### Jira auth & MCP topology (validated by the Phase 0 spike, 2026-10-03)
A single shared mcp-atlassian instance isolates tenants correctly **only** for modes where the Jira URL travels with the request. The spike (real mcp-atlassian @ `0a5d242` vs two recording mock Jiras, ~100 calls incl. concurrent) showed each tenant's Jira received only its own token, and credential-less requests are rejected (no fallback to operator credentials).

| Jira / credential | How the agent reaches mcp-atlassian | Status |
|---|---|---|
| DC + PAT | **Shared** instance; per request: `X-Atlassian-Jira-Url` + `X-Atlassian-Jira-Personal-Token` | Verified multi-tenant |
| Cloud + OAuth 2.0 (3LO, our Atlassian OAuth app) | **Shared** instance (`ATLASSIAN_OAUTH_ENABLE=true`); per request: `Authorization: Bearer <token>` + `X-Atlassian-Cloud-Id` | Code path confirmed by reading; live test in Phase 3 |
| Cloud + email/API token | Basic auth ignores the URL header (uses server-global `JIRA_URL`) → **one small mcp-atlassian instance per Cloud site**, started/stopped by the worker | Verified: shared mode fails |

Operational rules that follow:
- **SSRF guard:** mcp-atlassian always blocks `localhost`/private IPs in per-request URLs; self-hosters with internal DC hostnames must set `MCP_ALLOWED_URL_DOMAINS`. Our connection form validates URLs the same way before saving.
- **Never set** `ALLOW_GLOBAL_CRED_FALLBACK`, and never set global `JIRA_URL` on the shared instance.
- mcp-atlassian builds a new Jira client per request (no connection reuse) → measure latency against real Jira in Phase 3; if it hurts, cache per-tenant via the per-site instance pattern.
- **Tool surface:** mcp-atlassian exposes ~61 tools (Jira + Confluence, incl. writes). The agent gets an explicit allowlist of ~10–15 Jira tools; scheduled/background runs use a `--read-only` instance.
- The sync worker does **not** go through MCP; it calls Jira directly with jira.js using the same stored credentials.

**Phase 3 decisions (2026-10-04, recorded after implementation; the table above is the Phase 0 finding and stays as written):**
- **Cloud + email/API token uses a built-in REST tool backend, not per-site mcp-atlassian instances.** Starting containers from the worker needs the Docker socket (root on the host) or a Kubernetes API role in every deployment, a privilege we refuse, and O(sites) processes. The built-in backend reuses our redirect-free, DNS-pinned Jira client, exposes the same 11 tool names and inputs, and goes through the same approval gate; it converts Markdown to Jira wiki markup with a port of mcp-atlassian's converter so both backends post the same text. DC + PAT and Cloud + OAuth use the shared instance as above. If mcp-atlassian-only behaviour is ever needed for API tokens, a per-site instance operator can be added later.
- The shared instance runs mcp-atlassian `0.23.1`, pinned by digest and contract-tested (Testcontainers) against a mock Jira with all 11 tools. Its `ENABLED_TOOLS` is the 11-tool catalog plus `jira_search_assignable_users` (backend-only, for exact assignee resolution); the read-only twin (`READ_ONLY_MODE=true`) enables the 6 read tools and is shipped for Phase 4's scheduled runs. Neither is published outside the compose network. Live Cloud OAuth and per-request latency remain on the README's manual checklist.
- **Approval cards show the exact proposed values, not a before/after diff** (the "before" would need an extra Jira read per proposal and is stale by approval time). This refines "diff + Approve/Reject" in *Agent runtime* below.
- **The analytics MCP server runs in-process only until Phase 5** (in-memory transport, tools bound to the caller's workspace). Exposing it over streamable HTTP to external MCP clients needs its own authentication, rate limits and audit, which Phase 5 brings.
- Jira write tools are offered to workspace owners/admins only until Phase 5 roles. **Live Jira read tools too** (phase-3 review, 2026-10-04): they use the connection owner's credentials and can reach projects beyond the boards an admin selected, so members get the analytics tools only until Phase 5 roles bring explicit scopes.
- **Every approval names its Jira site** (phase-3 review): the site (connection id) is part of the hashed tool input even with one site (the server adds it; the model never chooses it then), and execution uses exactly that connection or fails closed; the approval card always shows the site.
- **An approved change always gets a result** (phase-3 review): a turn that fails before the change ran closes it as `failed`/`not_executed` with a fixed tool result, so the conversation never keeps a tool call without a result; a write cut off after it was sent is reported as `unknown_outcome`.

### 2. Sync + metrics engine (the trustworthy core)
- Worker syncs issues, sprints, boards and **status changelogs** incrementally and stores normalised tables (`issues`, `issue_transitions`, `sprints`, `sprint_membership`, `boards`).
- `packages/metrics` = pure functions over that data:
  - Scrum: velocity, commitment vs completion, scope change mid-sprint, burndown/burnup, carry-over
  - Kanban/flow: cycle time & lead time (percentiles), throughput, WIP, work-item age / aging WIP, cumulative flow diagram, flow efficiency, blocked time
  - Forecasting: **Monte Carlo** ("when will these N items be done?", "how many items by date X?") at 50/85/95%
  - Hygiene: stale issues, missing estimates, unassigned in-progress, oversized items
- Dashboard works **without an LLM** (good for trust, demos, and when keys fail).

### 3. Agent runtime
- One streaming endpoint; model resolved from the org's BYOK config via the AI SDK registry.
- Tools (via MCP):
  - **analytics MCP** (read): `get_metric`, `list_metrics`, `forecast`, `find_issues` (safe, parameterised filters — no free SQL), `explain_metric`
  - **mcp-atlassian** (read, allowlisted subset): JQL search, issue detail, comments, sprint/board info
  - **mcp-atlassian** (write): comment, transition, assign, create, update — **always gated by approval**: the UI shows an action card (diff + Approve/Reject); every decision goes to `audit_log`
- Prompt-injection safety: Jira content is treated as untrusted data; writes need human approval; tools are tenant-scoped on the server, never chosen by the model.
- Token/cost meter per user/org (BYOK users want to see spend).

### 4. Skills (personalisation through prompting)
- A skill = **SKILL.md-style** document (open Agent Skills format): frontmatter `name`, `description`, `scope` (boards/projects), `trigger` (`on_demand` | `always` preference | `schedule` cron | `alert` condition), `output` (chat | dashboard card | email | Slack) + markdown instructions.
- Progressive disclosure: the agent sees skill names + descriptions; it loads the full text through a `load_skill` tool when relevant (keeps context small, scales to many skills).
- **Skill builder:** user types "every Monday tell me which stories are at risk for the sprint goal" → the agent drafts the skill → **preview run on real data** → save. Versioned, can be forked, can be shared within the org.
- **Built-in library** (editable templates): Sprint health check, Daily standup brief, Retro prep, Stale/aging work detector, Scope-creep watcher, Delivery forecast, Blocker report, Kanban flow review, Team workload balance.
- **"Always" preferences** (e.g. "we use story points, sprint = 2 weeks, answer in French, never name individuals in reports") are injected into every conversation.

**Phase 4 decisions (2026-10-04; additions, the text above is unchanged):**
- **Skill runs are read-only.** Scheduled, alert and "Run now" runs (and builder previews) execute as the skill's owner with the owner's role read at run time: analytics tools for everyone, plus the Jira read tools (read-only mcp-atlassian twin, `MCP_ATLASSIAN_READONLY_URL`) for owners/admins only; members get analytics only (P3-R25). No write tool exists in a run, so nothing is proposed or queued for approval; reports recommend actions.
- **Skill text reaches the model only as the owner's own instructions**, as messages (never in the system prompt) inside a fixed `<skill>` envelope; names and descriptions are data until `load_skill`. A shared skill never reaches another member's assistant until they copy it from its own page; copies start disabled. Only the owner edits; owners/admins may delete shared skills. Run outputs and delivery detail are owner-only (P4-R1).
- **Email goes to the skill owner's account address only**, through the workspace's single SMTP channel (admin-configured, tested, encrypted, SSRF-checked, connection pinned to the checked address, STARTTLS required or implicit TLS; plaintext only towards `ALLOWED_PRIVATE_HOSTS`, re-checked at send). The address is not verified until Phase 5 SSO (P4-R9, accepted residual).
- **Slack/Teams (Teams added) are webhooks**, escaped and never unfurled, usable only by skills whose owner is owner/admin, checked at save and at run time (P4-R4). There is no hard webhook host allowlist (P4-R26); a Phase 5 option.
- **Alerts are a deterministic comparison** of one KPI metric with a number per board in scope, without a model call; edge-triggered, 12-hour cooldown.
- **Cost control:** background model per workspace; per run 6 steps, 2,000 output tokens, 120 s, no retries; schedules at most hourly; `SKILL_RUNS_DAILY_LIMIT` (default 50, 0 disables); builder drafts and previews 20 per user per hour (burst-safe reservation, P4-R29).
- **Runs are queued through pg-boss** (worker tick every 5 minutes; one job per run; stale queued runs re-sent after 10 minutes, closed after 30); delivery uses a snapshot of output and channel taken at planning (P4-R5); a skill whose owner left is auto-disabled (`owner_left`).
- **Pinning a widget is an in-app write without approval**: catalog-validated, server-made id, the caller's own "Pinned" dashboard, at most 40 widgets, audited, removable. Accepted residual: injected Jira text can make the model pin a chart.
- **Networks:** the read-only twin has its own `mcp-readonly` network shared by web and worker; `mcp` (read-write) stays web-only.
- Output values are `chat | dashboard_card | email | slack | teams`; `scope` lists board ids (projects map to boards). Live SMTP/Slack/Teams checks are a README manual checklist, not yet run.

### 5. Dashboard personalised by prompt
- Widgets are **declarative zod-validated specs** (`{metric, params, chart, title}`) rendered from a fixed catalog — the agent can "pin this to my dashboard" or "add a cycle-time chart for team X" without generating arbitrary code (safe + consistent).
- Multiple dashboards per user/board; skill outputs can appear as "insight cards".

### 6. Professional-grade extras (phased)
- Scheduled digests: email + Slack/Teams webhooks
- Executive report export (PDF) from a skill
- Portfolio view across projects/boards
- Org glossary/memory ("PI = program increment", team names) to improve answers
- i18n (EN/FR from day one via `next-intl`)
- Roles: Owner/Admin/Manager/Viewer; audit log export; data retention & deletion (GDPR); SSO
- Billing (Stripe) for SaaS only; disabled in self-host builds
- Agent quality: promptfoo eval suite on fixture Jira data for every built-in skill; Langfuse traces

---

## Delivery phases (each gets its own spec → plan → implementation cycle)
0. **Spike (throwaway):** ✅ mcp-atlassian multi-tenancy — done 2026-10-03 (results in *Jira auth & MCP topology*). ⏳ jira.js vs a DC trial container → moved into Phase 2. ⏳ tool calling + MCP + approvals across Anthropic/OpenAI/Gemini/Ollama → moved into Phase 3 (needs real API keys).
1. **Foundation:** monorepo, CI (lint/typecheck/test), Docker Compose, db + RLS, better-auth orgs, crypto package, Jira & LLM connection flows with test buttons.
2. **Data & dashboard:** sync worker (validated against a DC trial container + Cloud sandbox), status mapping, metrics package (fixture-driven tests), default Scrum and Kanban dashboards.
3. **Agent:** chat UI, BYOK registry, analytics MCP, mcp-atlassian integration (shared instance + per-Cloud-site instances, tool allowlist, live OAuth test), approval cards, audit log, cost meter. *Phase 3 implementation (2026-10-04) changed this as follows (see Phase 3 decisions in* Jira auth & MCP topology*): Cloud API tokens use a built-in REST backend instead of per-Cloud-site instances; approval cards show the exact proposed values, not a diff; the analytics MCP runs in-process only until Phase 5; the live provider (Anthropic/OpenAI/Gemini/Ollama) and live OAuth tests are a README manual checklist, not yet run.*
4. **Skills:** schema, library, builder with preview, scheduling, email/Slack digests, prompt-driven widgets. *Phase 4 implementation (2026-10-04): see the Phase 4 decisions under* Skills *(read-only runs, owner-only email, copy-to-adopt sharing, deterministic alerts, run limits); executive PDF export, org glossary and admin-set workspace preferences remain deferred.*
5. **Enterprise/SaaS:** SSO via Keycloak/OIDC + admin-only password login, billing, Langfuse, eval suite in CI, Helm chart, retention controls.

## Next step
Invoke `writing-plans` for **Phase 1 (Foundation)** and execute it with TDD.

## Verification
- **Metrics:** Vitest golden tests on fixture datasets (hand-computed cycle times, velocity, CFD, Monte Carlo seeded for determinism).
- **Tenancy/security:** integration tests proving org A cannot read org B (app layer + RLS); secrets never appear in API responses/logs.
- **Jira:** sync tested against a real Cloud sandbox and a DC trial container.
- **Agent:** promptfoo evals per built-in skill on fixture data, run against at least 2 providers; Playwright e2e for: sign-up → connect Jira → connect LLM → dashboard renders → ask a question → approve a proposed comment → audit entry exists.
- **Self-host:** `docker compose up` from a clean machine reaches a working dashboard.
