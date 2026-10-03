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
- **Auth & tenants:** **better-auth** with the organization plugin (workspaces, roles, invites); SSO (OIDC/SAML) plugin later for enterprise
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
3. **Agent:** chat UI, BYOK registry, analytics MCP, mcp-atlassian integration (shared instance + per-Cloud-site instances, tool allowlist, live OAuth test), approval cards, audit log, cost meter.
4. **Skills:** schema, library, builder with preview, scheduling, email/Slack digests, prompt-driven widgets.
5. **Enterprise/SaaS:** SSO, billing, Langfuse, eval suite in CI, Helm chart, retention controls.

## Next step
Invoke `writing-plans` for **Phase 1 (Foundation)** and execute it with TDD.

## Verification
- **Metrics:** Vitest golden tests on fixture datasets (hand-computed cycle times, velocity, CFD, Monte Carlo seeded for determinism).
- **Tenancy/security:** integration tests proving org A cannot read org B (app layer + RLS); secrets never appear in API responses/logs.
- **Jira:** sync tested against a real Cloud sandbox and a DC trial container.
- **Agent:** promptfoo evals per built-in skill on fixture data, run against at least 2 providers; Playwright e2e for: sign-up → connect Jira → connect LLM → dashboard renders → ask a question → approve a proposed comment → audit entry exists.
- **Self-host:** `docker compose up` from a clean machine reaches a working dashboard.
