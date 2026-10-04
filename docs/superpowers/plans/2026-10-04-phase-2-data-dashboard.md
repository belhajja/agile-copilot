# Phase 2 — Data & Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workspace selects Jira boards, reviews how each board's statuses map to *To do / In progress / Done*, and a background worker keeps boards, sprints, issues and their full status/sprint/estimate history in sync (Cloud and Data Center, incremental, rate-limit aware). Pure, golden-tested metric functions turn that history into default Scrum and Kanban dashboards — built from shadcn's `dashboard-01` block and `chart` component, rendered from zod-validated widget specs — that work without any LLM.

**Architecture:** Five new pieces on top of Phase 1. `@agile/jira` gains a Jira *data source* (jira.js v6 for Cloud, jira.js v5 for Data Center, both redirect-safe, paginated, retrying 429s) plus pure changelog normalisation. `@agile/sync` stores what the data source reads (tenant tables, RLS) and owns the pg-boss queue: "Sync now", a cron tick, and the sync job. `apps/worker` is a thin process running those jobs. `@agile/metrics` is pure: `(dataset, now) → numbers`. `@agile/dashboards` holds the widget catalog (zod), the default layouts, dashboard persistence, the DB → metrics dataset loader and `computeWidget`. `apps/web` adds the board/status-mapping settings page and the board dashboards. A Task 0 group first lands the backlog deferred by the Phase 1 review.

**Tech Stack (new in Phase 2):** pg-boss 12.36.0 (Postgres queue + cron, ESM, Node ≥ 22.12), pure-rand 8.4.2 (seeded PRNG for Monte Carlo), recharts 3.8.0 (installed by `shadcn add chart`), tsx 4.23.15 (runs the worker's TypeScript in production). Everything from Phase 1 is unchanged: Node 24, pnpm 10.14, TypeScript 7.0.2, Next.js 16.3.8, React 19.3, drizzle-orm 0.45.3 / drizzle-kit 0.31.11, PostgreSQL 17, jira.js 6.2.0 + `jira-js-v5` (jira.js 5.4.0), zod 4.6.5, next-intl 4.14.9, shadcn 4.21 (Radix base, radix-nova style), Vitest 5.0.3, Testcontainers 12.2, Playwright 1.63, Biome 2.5.15.

**Spec:** `docs/superpowers/specs/2026-10-03-agile-copilot-design.md` — "Sync + metrics engine", "Dashboard personalised by prompt", "Connections" (status mapping, board selection), "Delivery phases" (Phase 2).

**Previous plan (format and constraints):** `docs/superpowers/plans/2026-10-03-phase-1-foundation.md`.

**How this plan was checked:** every code block was applied, in task order, to a scratch worktree of `feat/phases-2-5` and run there: Biome, `tsc`, Vitest (34 files, 249 tests, Testcontainers Postgres 17), `next build`, Playwright (11 tests against the mock Jira and a real worker) and `docker build --target worker` (the image answered `/health`). The jira.js v6/v5 and pg-boss 12 calls were type-checked and exercised against the installed packages, not written from memory. Generated files (migration names, shadcn components) will differ in name only.

## Global Constraints

Phase 1 constraints still bind:

- Node `>=24`; pnpm `10.14.0`; every package is `"type": "module"`.
- Exact dependency versions; `skipLibCheck: true`; lint/format with **Biome only** (`pnpm lint`, `pnpm format`).
- `org_id`/`user_id` columns are `text`. Every tenant table has `org_id text not null`, the `tenantPolicy` RLS policy, and `FORCE ROW LEVEL SECURITY`; it is only accessed inside `withOrg(db, orgId, fn)`. The app (web **and worker**) connects as `app_user`; migrations run as the owner (`DATABASE_OWNER_URL`).
- Secrets (Jira tokens, OAuth tokens, LLM keys) are encrypted per org and never reach the browser, API responses, logs, error messages or `audit_log.metadata`.
- jira.js **v6 is Cloud-only**; Data Center uses `jira-js-v5` (`Version2Client`, `AgileClient`, PAT as OAuth2 bearer, `maxRedirects: 0`).
- Identity is read only through `requireActor()`; Next.js 16 conventions (`src/proxy.ts`, awaited `params`/`headers()`/`cookies()`).
- Every user-facing string lives in `apps/web/messages/{en,fr}.json` (EN and FR always together).
- UI is shadcn/ui (Radix base), **blocks first, components second**; never hand-edit `src/components/ui/*` (add them with `pnpm --filter @agile/web exec shadcn add …`); no custom CSS beyond Tailwind utilities.
- User-supplied outbound URLs pass `checkOutboundUrl`; Vitest 5 (`vite` peer, `vi.mock` at top level, `defineProject` per package).

New in Phase 2:

- **One HTTP policy.** Every outbound request to a user-supplied or token-bearing URL goes through `fetchNoRedirect` from `@agile/net` (jira.js v6 through `createNoRedirectClient`, which uses it) or jira.js v5 with `maxRedirects: 0`. APIs without an `AbortSignal` are bounded with `withDeadline` from `@agile/net`. No other `redirect: 'manual'` or `Promise.race` timeout helpers.
- **Jira responses are untrusted input.** The sync validates what it reads with its own lenient zod schemas (`packages/jira/src/responses.ts`, client created with `schemaValidation: 'lenient'`), never with jira.js's strict response schemas. Changelog `fromString`/`toString` are read as own properties only and renamed `fromText`/`toText`.
- **Tenant tables:** every foreign key between tenant tables is `ON DELETE CASCADE` (a schema-guard test enforces it) so that deleting a connection or purging an organisation removes everything derived from it. FORCE RLS goes in a `drizzle-kit generate --custom` migration; generated SQL is never hand-edited.
- **Jobs:** pg-boss 12 lives in schema `pgboss`, which a migration creates `AUTHORIZATION app_user`; web and worker start pg-boss with `createSchema: false`. Queues are created idempotently at start. A connection never has more than one queued-or-active sync (`policy: 'exclusive'` + `singletonKey: connectionId`, plus a database lease in `runSync`).
- **Metrics are pure:** functions of `(dataset, now)` only — no I/O, no `Date.now()`, seeded randomness. Day buckets are UTC days.
- **Stored errors are codes, never messages.** Logs carry the code and the error *name*, never `error.message`.
- **Widgets are data:** `{ id, metric, chart, title?, params }` validated by `widgetSpecSchema` and rendered from the fixed catalog; no generated code.
- **Ports:** dev Postgres 5433, e2e app 3200, mock Jira 4010, mock LLM 4020, e2e worker health 4030 (container: 8080). Ports 5432, 3000 and 3100 belong to other projects on the developer machine: never start anything on them while implementing.
- New dependencies are pinned to exactly the versions in Tech Stack.

## Review Focus

The five real-world inputs most likely to break this phase, each pinned by a test in the task that owns it:

1. **Changelog items without `fromString`/`toString` keys** (Data Center omits empty keys; Cloud omits them for some fields). Read naively, `item.toString` is `Object.prototype.toString` — a truthy function — and zod's `toString` key matches it too. Pinned in Task 4 (`normalizeIssue` test with a status item carrying no text keys) and by the `RawChangelogItem` type that renames them.
2. **Jira users outside UTC.** Absolute JQL dates are interpreted in the Jira user's time zone, so `updated >= "2026-10-04 10:00"` silently skips hours of updates. The incremental window is relative (`updated >= "-75m"`) with a 15-minute overlap. Pinned in Task 4 (`buildIssueJql`) and Task 8 (incremental sync asserts the JQL actually sent).
3. **Truncated changelogs in search results** (issues with long histories come back with a partial `changelog`). Missing transitions silently corrupt cycle times. `completeHistories` fetches the full changelog whenever `total > histories.length`. Pinned in Task 6 (contract test with the mock truncating every search changelog to one entry, for Cloud and Data Center).
4. **HTTP 429 with `Retry-After` during a large sync** (Jira Cloud rate limits). Both jira.js v6 (our client) and v5 (axios) error shapes must yield the status and the delay. Pinned in Task 6 (rate-limit unit test and a contract test where the mock answers 429 twice, both flavours).
5. **"Sync now" while the scheduled sync of the same connection runs.** Two concurrent syncs would double the Jira load and race on the same rows. Pinned in Task 8 (two concurrent `runSync` calls → one `already_running`) and Task 9 (second `requestSync` → `queued: false`).

---

## File Structure

```
packages/net/src/http.ts                      fetchNoRedirect, RedirectBlockedError, withDeadline
packages/jira/src/no-redirect-client.ts       jira.js v6 Client: JSON bodies, locked Authorization, JiraHttpError
packages/jira/src/sync-types.ts               board/sprint/status/field/issue types the sync reads and writes
packages/jira/src/issue-normalize.ts          raw issue + changelog → transitions, changes, sprint membership; JQL window
packages/jira/src/responses.ts                lenient zod schemas for the Jira responses the sync reads
packages/jira/src/rate-limit.ts               withRateLimitRetry (429/503, Retry-After)
packages/jira/src/data-source.ts              JiraDataSource: Cloud (jira.js v6) and Data Center (jira.js v5)
packages/jira/src/testing/demo-dataset.ts     deterministic demo boards/sprints/issues (e2e, local review)
packages/jira/src/testing/mock-jira-server.ts mock Jira + agile/search/changelog endpoints, pagination, 429
packages/db/src/purge.ts                      purgeOrgTenantRows (organisation deletion)
packages/db/src/schema/tenant.ts              tenantPolicy, createdAt, updatedAt (shared by all schema files)
packages/db/src/schema/jira-data.ts           jira_boards … jira_sprint_issues, sync state/runs, status mappings
packages/db/src/schema/dashboards.ts          dashboards (per user and board, widgets as jsonb)
packages/metrics/src/{model,time,stats,issue}.ts   dataset model and helpers
packages/metrics/src/scrum.ts                 velocity, say/do, scope change, carry-over, burndown/burnup
packages/metrics/src/flow.ts                  cycle/lead time, throughput, WIP, aging WIP, CFD, flow efficiency
packages/metrics/src/hygiene.ts               stale, missing estimate, unassigned in progress, oversized
packages/metrics/src/forecast.ts              Monte Carlo "how many" / "when"
packages/metrics/src/fixtures.ts              hand-built golden datasets for the tests
packages/sync/src/deps.ts                     SyncDeps, SyncError, failure codes
packages/sync/src/credentials.ts              credentials (OAuth refresh, URL re-check) → data source
packages/sync/src/persist.ts                  upserts for boards, sprints, issues, history; pruning
packages/sync/src/boards.ts                   discover/list/select boards, status mappings, sync state
packages/sync/src/run-sync.ts                 runSync (lease, full/incremental, per-board sync)
packages/sync/src/queue.ts                    pg-boss: startSyncQueue, requestSync, scheduled tick, workers
packages/sync/src/test-harness.ts             Testcontainers DB + mock Jira harness (exported as @agile/sync/testing)
packages/dashboards/src/widget-spec.ts        widgetSpecSchema (the catalog), parseWidgets
packages/dashboards/src/widget-data.ts        WidgetData (what a widget renders)
packages/dashboards/src/compute.ts            computeWidget(spec, dataset, now)
packages/dashboards/src/layouts.ts            default Scrum and Kanban layouts
packages/dashboards/src/dataset.ts            loadBoardDataset (DB → BoardDataset), toMetricIssue
packages/dashboards/src/store.ts              ensureDefaultDashboards, listDashboards, saveDashboardWidgets
packages/config/src/worker-env.ts             parseWorkerEnv (SYNC_INTERVAL_MINUTES, WORKER_HEALTH_PORT)
apps/worker/src/{main,worker,health,log}.ts   the sync worker process
apps/web/src/server/sync.ts                   syncDeps(), syncQueue() (pg-boss producer)
apps/web/src/components/confirm-delete-button.tsx  shadcn alert-dialog confirmation
apps/web/src/app/(app)/settings/jira/[connectionId]/  boards, status mapping, Sync now
apps/web/src/components/dashboard/            KPI cards (dashboard-01), chart/table widgets, dashboard view
apps/web/src/app/(app)/boards/[boardId]/page.tsx   a board's dashboards (Tabs)
e2e/tests/sync-dashboards.spec.ts             connect → select → map → sync → dashboards
```

Task order is a dependency order: each task only uses what earlier tasks built.

---

## Part 0 — Phase-2 prep backlog (deferred from the Phase 1 review; lands first)

### Task 0.1: `@agile/net` — one `fetchNoRedirect` and one `withDeadline`, adopted everywhere

**Files:**
- Create: `packages/net/src/http.ts`
- Modify: `packages/net/src/index.ts`, `packages/llm/package.json`, `packages/llm/src/providers.ts`, `packages/jira/src/oauth.ts`, `packages/jira/src/probe.ts`, `packages/connections/src/jira-oauth.ts`
- Test: `packages/net/src/http.test.ts`

**Interfaces:**
- Produces (from `@agile/net`): `fetchNoRedirect: typeof fetch` (forces `redirect: 'manual'`; any 3xx → cancels the body and throws `RedirectBlockedError`), `class RedirectBlockedError extends TypeError { name: 'RedirectBlockedError'; status: number }`, `withDeadline<T>(promise: Promise<T>, ms: number, onTimeout?: () => Error): Promise<T>` (always clears its timer), `class DeadlineExceededError extends Error { name: 'TimeoutError'; ms: number }`.
- Kept behaviour: `mapJiraError` maps any error with a 3xx `status` to `not_jira` and `name === 'TimeoutError'` to `unreachable`; the LLM probe maps `name === 'RedirectBlockedError'` to `unreachable`; `OAuthTimeoutError` is still what OAuth deadlines throw.

- [ ] **Step 1: Write the failing tests**

`packages/net/src/http.test.ts`:
```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DeadlineExceededError, fetchNoRedirect, RedirectBlockedError, withDeadline } from './http';

describe('fetchNoRedirect', () => {
  const hits: string[] = [];
  let server: Server;
  let base = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/redirect') {
        res.writeHead(302, { location: `${base}/target` }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  afterEach(() => {
    hits.length = 0;
  });

  it('returns non-redirect responses untouched', async () => {
    const res = await fetchNoRedirect(`${base}/ok`);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('refuses a redirect without contacting its target', async () => {
    const err = await fetchNoRedirect(`${base}/redirect`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedirectBlockedError);
    expect(err).toMatchObject({ name: 'RedirectBlockedError', status: 302 });
    expect((err as Error).message).toMatch(/302/);
    expect(hits).toEqual(['/redirect']);
  });

  it('ignores a caller asking to follow redirects', async () => {
    await expect(fetchNoRedirect(`${base}/redirect`, { redirect: 'follow' })).rejects.toThrow(
      RedirectBlockedError,
    );
    expect(hits).toEqual(['/redirect']);
  });
});

describe('withDeadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the value and clears its timer', async () => {
    vi.useFakeTimers();
    await expect(withDeadline(Promise.resolve(42), 1_000)).resolves.toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its timer when the promise rejects', async () => {
    vi.useFakeTimers();
    await expect(withDeadline(Promise.reject(new Error('boom')), 1_000)).rejects.toThrow('boom');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with a TimeoutError once the deadline passes', async () => {
    vi.useFakeTimers();
    const pending = withDeadline(new Promise<never>(() => {}), 1_000);
    const assertion = expect(pending).rejects.toBeInstanceOf(DeadlineExceededError);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('uses the caller-supplied error', async () => {
    class Custom extends Error {}
    await expect(
      withDeadline(new Promise<never>(() => {}), 5, () => new Custom()),
    ).rejects.toBeInstanceOf(Custom);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project net`
Expected: FAIL — `Cannot find module './http'`.

- [ ] **Step 3: Implement**

`packages/net/src/http.ts`:
```ts
/** A 3xx answer was refused: following it could bounce a server-side request to an unchecked host. */
export class RedirectBlockedError extends TypeError {
  override name = 'RedirectBlockedError';
  constructor(readonly status: number) {
    super(`Redirect blocked (HTTP ${status})`);
  }
}

/** The deadline passed first. Named `TimeoutError` like `AbortSignal.timeout()` aborts, so callers map both the same way. */
export class DeadlineExceededError extends Error {
  override name = 'TimeoutError';
  constructor(readonly ms: number) {
    super(`Deadline of ${ms} ms exceeded`);
  }
}

/**
 * `fetch` that never follows redirects. Every outbound call to a user-supplied or token-bearing URL
 * goes through here: a public host must not be able to bounce us (and our credentials) elsewhere.
 */
export const fetchNoRedirect: typeof fetch = async (input, init) => {
  const res = await fetch(input, { ...init, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new RedirectBlockedError(res.status);
  }
  return res;
};

/**
 * Rejects with `onTimeout()` (default DeadlineExceededError) if `promise` has not settled within
 * `ms`. The timer is always cleared, so a settled promise leaves nothing scheduled behind it.
 * Use it for APIs that take no AbortSignal; the underlying work is not cancelled.
 */
export async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error = () => new DeadlineExceededError(ms),
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
```

`packages/net/src/index.ts`:
```ts
export * from './http';
export * from './outbound-url';
```

- [ ] **Step 4: Run the net tests**

Run: `pnpm vitest run --project net`
Expected: PASS — 23 tests (7 new + 16 outbound-url).

- [ ] **Step 5: Replace the duplicated helpers**

Apply these edits (they are exact; `git apply` accepts them, or edit by hand). The Jira no-redirect client is rewritten on top of `fetchNoRedirect` in Task 0.2.

`packages/llm/package.json` and `packages/llm/src/providers.ts` (drop the local `noRedirectFetch`):
```diff
diff --git a/packages/llm/package.json b/packages/llm/package.json
--- a/packages/llm/package.json
+++ b/packages/llm/package.json
@@ -11,6 +11,7 @@
     "typecheck": "tsc -p tsconfig.json"
   },
   "dependencies": {
+    "@agile/net": "workspace:*",
     "@ai-sdk/anthropic": "4.0.71",
     "@ai-sdk/azure": "4.0.90",
     "@ai-sdk/google": "4.0.87",
diff --git a/packages/llm/src/providers.ts b/packages/llm/src/providers.ts
--- a/packages/llm/src/providers.ts
+++ b/packages/llm/src/providers.ts
@@ -1,3 +1,4 @@
+import { fetchNoRedirect } from '@agile/net';
 import { createAnthropic } from '@ai-sdk/anthropic';
 import { createAzure } from '@ai-sdk/azure';
 import { createGoogleGenerativeAI } from '@ai-sdk/google';
@@ -16,18 +17,6 @@ export type LlmConfig =
 
 const AZURE_RESOURCE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
 
-/** fetch that never follows redirects (a user-supplied URL must not bounce us to internal hosts). */
-const noRedirectFetch: typeof fetch = async (input, init) => {
-  const res = await fetch(input, { ...init, redirect: 'manual' });
-  if (res.status >= 300 && res.status < 400) {
-    await res.body?.cancel();
-    throw Object.assign(new TypeError('Redirects are not allowed'), {
-      name: 'RedirectBlockedError',
-    });
-  }
-  return res;
-};
-
 /** Builds a model from a tenant's own key at call time (keys are never read from process.env). */
 export function createLanguageModel(cfg: LlmConfig): LanguageModel {
   switch (cfg.provider) {
@@ -48,7 +37,8 @@ export function createLanguageModel(cfg: LlmConfig): LanguageModel {
         name: 'openai_compatible',
         baseURL: cfg.baseUrl,
         apiKey: cfg.apiKey || 'not-needed',
-        fetch: noRedirectFetch,
+        // A user-supplied URL must not bounce us to internal hosts.
+        fetch: fetchNoRedirect,
       })(cfg.model);
   }
 }
```

`packages/jira/src/oauth.ts` (accessible-resources call) and `packages/jira/src/probe.ts` (drop the local `withTimeout`, which never cleared its timer):
```diff
diff --git a/packages/jira/src/oauth.ts b/packages/jira/src/oauth.ts
--- a/packages/jira/src/oauth.ts
+++ b/packages/jira/src/oauth.ts
@@ -1,3 +1,4 @@
+import { fetchNoRedirect } from '@agile/net';
 import { Atlassian } from 'arctic';
 import { z } from 'zod';
 
@@ -50,12 +51,11 @@ export async function listAccessibleJiraSites(
   accessToken: string,
   opts: { apiBase?: string } = {},
 ): Promise<AtlassianSite[]> {
-  const res = await fetch(
+  // Never follow redirects: a bearer token must not be replayed to another host.
+  const res = await fetchNoRedirect(
     `${opts.apiBase ?? 'https://api.atlassian.com'}/oauth/token/accessible-resources`,
     {
       headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
-      // Never follow redirects: a bearer token must not be replayed to another host.
-      redirect: 'manual',
       signal: AbortSignal.timeout(15_000),
     },
   );
diff --git a/packages/jira/src/probe.ts b/packages/jira/src/probe.ts
--- a/packages/jira/src/probe.ts
+++ b/packages/jira/src/probe.ts
@@ -1,3 +1,4 @@
+import { withDeadline } from '@agile/net';
 import { createCloudClient } from 'jira.js';
 import { Version2Client } from 'jira-js-v5';
 import { mapJiraError } from './errors';
@@ -10,14 +11,6 @@ export interface ProbeOptions {
   timeoutMs?: number;
 }
 
-const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
-  Promise.race([
-    p,
-    new Promise<never>((_, reject) =>
-      setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), ms),
-    ),
-  ]);
-
 async function probeCloud(
   c: Exclude<JiraCredentials, { kind: 'datacenter_pat' }>,
   opts: ProbeOptions,
@@ -88,7 +81,7 @@ export async function probeJira(
 ): Promise<JiraTestResult> {
   try {
     const run = c.kind === 'datacenter_pat' ? probeDataCenter(c) : probeCloud(c, opts);
-    return await withTimeout(run, opts.timeoutMs ?? 15_000);
+    return await withDeadline(run, opts.timeoutMs ?? 15_000);
   } catch (e) {
     return mapJiraError(e);
   }
```

`packages/connections/src/jira-oauth.ts` (drop the local `withDeadline`; keep throwing `OAuthTimeoutError`):
```diff
diff --git a/packages/connections/src/jira-oauth.ts b/packages/connections/src/jira-oauth.ts
--- a/packages/connections/src/jira-oauth.ts
+++ b/packages/connections/src/jira-oauth.ts
@@ -6,6 +6,7 @@ import {
   listAccessibleJiraSites,
   normalizeBaseUrl,
 } from '@agile/jira';
+import { withDeadline } from '@agile/net';
 import { and, eq, sql } from 'drizzle-orm';
 import type { Actor } from './actor';
 import { assertCanManage } from './actor';
@@ -32,21 +33,6 @@ export class OAuthTimeoutError extends Error {
   }
 }
 
-/** arctic's token requests carry no AbortSignal, so enforce a deadline ourselves. */
-async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
-  let timer: ReturnType<typeof setTimeout> | undefined;
-  try {
-    return await Promise.race([
-      promise,
-      new Promise<never>((_, reject) => {
-        timer = setTimeout(() => reject(new OAuthTimeoutError()), ms);
-      }),
-    ]);
-  } finally {
-    clearTimeout(timer);
-  }
-}
-
 /** The refresh token was rejected (expired, revoked, already rotated) or Atlassian failed. */
 export class OAuthRefreshError extends Error {
   override name = 'OAuthRefreshError';
@@ -71,7 +57,12 @@ export async function completeJiraOAuth(
   let tokens: Awaited<ReturnType<AtlassianOAuthClient['validateAuthorizationCode']>>;
   let sites: Awaited<ReturnType<typeof listAccessibleJiraSites>>;
   try {
-    tokens = await withDeadline(deps.oauth.validateAuthorizationCode(code), ms);
+    // arctic's token requests take no AbortSignal, so enforce a deadline around them.
+    tokens = await withDeadline(
+      deps.oauth.validateAuthorizationCode(code),
+      ms,
+      () => new OAuthTimeoutError(),
+    );
     sites = await (deps.listSites ?? listAccessibleJiraSites)(tokens.accessToken());
   } catch {
     return { ok: false, code: 'oauth_failed' };
@@ -218,6 +209,7 @@ export async function getFreshJiraCredentials(
       const tokens = await withDeadline(
         deps.oauth.refreshAccessToken(secret.oauth.refreshToken),
         deps.oauthTimeoutMs ?? DEADLINE_MS,
+        () => new OAuthTimeoutError(),
       );
       accessToken = tokens.accessToken();
       rotated = {
```

- [ ] **Step 6: Run the affected suites, lint, typecheck**

Run:
```bash
pnpm install
pnpm vitest run --project net --project jira --project llm --project connections
pnpm lint && pnpm typecheck
grep -rn "redirect: 'manual'\|Promise.race" packages --include=*.ts | grep -v '\.test\.ts'
```
Expected: all PASS (the existing redirect tests — `oauth.test.ts` "does not follow redirects", the probe SSRF tests, the LLM probe redirect test — still pass unchanged; the connections suite includes the OAuth deadline test "times out a hung refresh"). Biome and tsc clean. The grep prints only `packages/net/src/http.ts` (twice: `redirect: 'manual'` and `Promise.race`) and `packages/jira/src/no-redirect-client.ts` (replaced in Task 0.2).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(net): one fetchNoRedirect and one withDeadline for every outbound call

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 0.2: Jira no-redirect client — JSON bodies, locked `Authorization`, jira.js parameter encoding, typed HTTP errors

**Files:**
- Modify: `packages/jira/src/no-redirect-client.ts` (full rewrite)
- Test: `packages/jira/src/no-redirect-client.test.ts`

**Interfaces:**
- Produces: `createNoRedirectClient(config: NoRedirectClientConfig): Client` (jira.js v6 `Client`), `NoRedirectClientConfig = { host; auth: JiraAuth; schemaValidation?: 'strict' | 'lenient'; timeoutMs?: number }`, `JiraAuth = { type: 'basic'; email; apiToken } | { type: 'bearer'; token }`, `class JiraHttpError extends Error { name: 'JiraHttpError'; status: number; retryAfterMs?: number }`, `parseRetryAfter(value: string | null, now?: number): number | undefined`.
- Behaviour other tasks rely on: request bodies are JSON for any method; caller headers can never replace `Authorization` (set last, case-insensitively); search params follow jira.js (arrays repeat the key, nullish values are skipped — the old client sent `nextPageToken=undefined`); 3xx → `RedirectBlockedError` (`status` set, from `fetchNoRedirect`); other non-2xx → `JiraHttpError` with `retryAfterMs` from `Retry-After`; 204 → `undefined`; `schemaValidation: 'lenient'` returns the parsed JSON without jira.js's response schema (Task 6 validates with its own schemas). Default stays `'strict'` so `probeJira` behaves as before.

- [ ] **Step 1: Write the failing tests**

`packages/jira/src/no-redirect-client.test.ts`:
```ts
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RedirectBlockedError } from '@agile/net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNoRedirectClient, JiraHttpError, parseRetryAfter } from './no-redirect-client';

interface Seen {
  method?: string;
  url?: string;
  authorization?: string;
  contentType?: string;
  body: string;
}

describe('createNoRedirectClient', () => {
  let server: Server;
  let base = '';
  let seen: Seen[] = [];
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => resolve(body));
    });

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      seen.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: await read(req),
      });
      if (req.url?.startsWith('/redirect')) {
        res.writeHead(302, { location: 'http://127.0.0.1:1/internal' }).end();
      } else if (req.url?.startsWith('/limited')) {
        res.writeHead(429, { 'retry-after': '7' }).end();
      } else if (req.url?.startsWith('/empty')) {
        res.writeHead(204).end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"1","extra":true}');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  beforeEach(() => {
    seen = [];
  });

  const client = () =>
    createNoRedirectClient({ host: `${base}/`, auth: { type: 'bearer', token: 'tok' } });

  it('sends a JSON body with POST and PUT', async () => {
    await client().sendRequest({ url: '/rest/x', method: 'POST', body: { jql: 'a = b' } });
    await client().sendRequest({ url: 'rest/y', method: 'PUT', body: { n: 1 } });
    expect(seen).toMatchObject([
      { method: 'POST', url: '/rest/x', contentType: 'application/json', body: '{"jql":"a = b"}' },
      { method: 'PUT', url: '/rest/y', contentType: 'application/json', body: '{"n":1}' },
    ]);
  });

  it('never lets a caller header replace the credentials', async () => {
    await client().sendRequest({
      url: '/rest/x',
      headers: { authorization: 'Bearer evil', Authorization: 'Bearer worse' },
    });
    expect(seen[0]?.authorization).toBe('Bearer tok');
  });

  it('encodes search params like jira.js and skips missing ones', async () => {
    await client().sendRequest({
      url: '/rest/search',
      searchParams: {
        jql: 'project = A',
        nextPageToken: undefined,
        fields: ['summary', 'status'],
        maxResults: 50,
        startAt: null,
      },
    });
    const url = new URL(seen[0]?.url ?? '', base);
    expect(url.searchParams.getAll('fields')).toEqual(['summary', 'status']);
    expect(url.searchParams.get('jql')).toBe('project = A');
    expect(url.searchParams.get('maxResults')).toBe('50');
    expect(url.searchParams.has('nextPageToken')).toBe(false);
    expect(url.searchParams.has('startAt')).toBe(false);
  });

  it('refuses redirects', async () => {
    await expect(client().sendRequest({ url: '/redirect' })).rejects.toMatchObject({
      name: 'RedirectBlockedError',
      status: 302,
    });
    await expect(client().sendRequest({ url: '/redirect' })).rejects.toBeInstanceOf(
      RedirectBlockedError,
    );
  });

  it('surfaces the status and Retry-After of a failed request', async () => {
    const err = await client()
      .sendRequest({ url: '/limited' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraHttpError);
    expect(err).toMatchObject({ status: 429, retryAfterMs: 7_000 });
  });

  it('returns undefined for 204', async () => {
    expect(await client().sendRequest({ url: '/empty', method: 'DELETE' })).toBeUndefined();
  });

  it('validates strictly by default and passes raw JSON in lenient mode', async () => {
    const schema = z.object({ id: z.number() });
    await expect(client().sendRequest({ url: '/ok', schema })).rejects.toMatchObject({
      name: 'SchemaMismatchError',
    });
    const lenient = createNoRedirectClient({
      host: base,
      auth: { type: 'basic', email: 'a@b.c', apiToken: 't' },
      schemaValidation: 'lenient',
    });
    expect(await lenient.sendRequest({ url: '/ok', schema })).toEqual({ id: '1', extra: true });
    expect(seen.at(-1)?.authorization).toBe(`Basic ${Buffer.from('a@b.c:t').toString('base64')}`);
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates, ignores garbage', () => {
    const now = Date.parse('2026-10-04T10:00:00Z');
    expect(parseRetryAfter('3', now)).toBe(3_000);
    expect(parseRetryAfter('Sun, 04 Oct 2026 10:00:05 GMT', now)).toBe(5_000);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project jira src/no-redirect-client.test.ts`
Expected: FAIL — `JiraHttpError` / `parseRetryAfter` are not exported (the file does not load).

- [ ] **Step 3: Implement**

`packages/jira/src/no-redirect-client.ts`:
```ts
import { fetchNoRedirect } from '@agile/net';
import type { Client, SendRequestOptions } from 'jira.js/core';

export type JiraAuth =
  | { type: 'basic'; email: string; apiToken: string }
  | { type: 'bearer'; token: string };

export interface NoRedirectClientConfig {
  host: string;
  auth: JiraAuth;
  /**
   * 'strict' (default) throws SchemaMismatchError when a body does not match jira.js's schema.
   * 'lenient' returns the parsed JSON as-is: sync code validates with its own, looser schemas, so
   * a field Atlassian added or renamed does not stop a whole sync.
   */
  schemaValidation?: 'strict' | 'lenient';
  /** Per-request deadline (default 30 s). */
  timeoutMs?: number;
}

/** A non-2xx answer from Jira. `retryAfterMs` is set when Jira sent a usable Retry-After header. */
export class JiraHttpError extends Error {
  override name = 'JiraHttpError';
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(`Jira request failed with HTTP ${status}`);
  }
}

/** Retry-After is either delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Same encoding as jira.js's own client: arrays repeat the key, objects are JSON, nullish is skipped. */
function appendSearchParams(url: URL, params: Record<string, unknown> | undefined) {
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) url.searchParams.append(key, String(item));
      }
    } else if (typeof value === 'object') {
      url.searchParams.set(key, JSON.stringify(value));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

/**
 * jira.js v6 `Client` that never follows redirects. jira.js's own client calls global `fetch` with
 * `redirect: 'follow'` and exposes no option for it, which would let a public host bounce the
 * server — with our credentials — to an internal address (SSRF). A 3xx surfaces as
 * RedirectBlockedError (`status` set), any other non-2xx as JiraHttpError.
 */
export function createNoRedirectClient(config: NoRedirectClientConfig): Client {
  const authorization =
    config.auth.type === 'basic'
      ? `Basic ${Buffer.from(`${config.auth.email}:${config.auth.apiToken}`).toString('base64')}`
      : `Bearer ${config.auth.token}`;
  const host = config.host.replace(/\/+$/, '');
  return {
    async sendRequest<T>(options: SendRequestOptions<T>): Promise<T> {
      const url = new URL(host + (options.url.startsWith('/') ? options.url : `/${options.url}`));
      appendSearchParams(url, options.searchParams);
      const headers = new Headers(options.headers);
      headers.set('Accept', 'application/json');
      const hasBody = options.body !== undefined && options.body !== null;
      if (hasBody) headers.set('Content-Type', 'application/json');
      // Set last, case-insensitively: a caller header can never replace our credentials.
      headers.set('Authorization', authorization);
      const res = await fetchNoRedirect(url, {
        method: options.method ?? 'GET',
        headers,
        body: hasBody ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(config.timeoutMs ?? 30_000),
      });
      if (!res.ok) {
        await res.body?.cancel();
        throw new JiraHttpError(res.status, parseRetryAfter(res.headers.get('retry-after')));
      }
      const text = await res.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        throw Object.assign(new Error('Response was not JSON'), { name: 'SchemaMismatchError' });
      }
      if (options.schema && data !== undefined && config.schemaValidation !== 'lenient') {
        const parsed = options.schema.safeParse(data);
        if (!parsed.success) {
          throw Object.assign(new Error('Response did not match the schema'), {
            name: 'SchemaMismatchError',
          });
        }
        return parsed.data;
      }
      return data as T;
    },
  };
}
```

- [ ] **Step 4: Run the Jira suite, lint, typecheck**

Run: `pnpm vitest run --project jira && pnpm lint && pnpm typecheck`
Expected: PASS — 38 tests (8 new; the probe tests still map a 302 to `not_jira` and a 401 to `unauthorized` through the new error types).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(jira): JSON bodies, locked Authorization and typed errors in the no-redirect client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 0.3: Deleting connections — promote the next LLM default; confirm deletions with an alert dialog

**Files:**
- Modify: `packages/connections/src/llm-connections.ts` (`deleteLlmConnection`), `packages/connections/src/llm-connections.test.ts`
- Create (shadcn): `apps/web/src/components/ui/alert-dialog.tsx` via `shadcn add`
- Create: `apps/web/src/components/confirm-delete-button.tsx`
- Modify: `apps/web/src/app/(app)/settings/jira/jira-connection-item.tsx`, `apps/web/src/app/(app)/settings/llm/llm-connection-item.tsx`, `apps/web/messages/{en,fr}.json`
- Test: `e2e/tests/jira-connection.spec.ts` (new test)

**Interfaces:**
- `deleteLlmConnection(deps, actor, id)`: same signature and result. When the deleted connection was the default, the most recently created remaining connection (ties: highest id) becomes the default in the same transaction (under the per-org default lock) and `llm_connection.default_changed` is audited with `metadata: { reason: 'previous_default_deleted' }`. Deleting the last connection leaves no default.
- Produces: `ConfirmDeleteButton({ onConfirm: () => Promise<void>; labels: ConfirmDeleteLabels })`, `ConfirmDeleteLabels = { trigger; title; description; confirm; cancel }` (client component; `onConfirm` is a bound server action).

- [ ] **Step 1: Update the LLM test to the new rule (failing)**

Replace the last test of `packages/connections/src/llm-connections.test.ts` (it asserted "deleting the default leaves none") and add the imports:
```diff
diff --git a/packages/connections/src/llm-connections.test.ts b/packages/connections/src/llm-connections.test.ts
--- a/packages/connections/src/llm-connections.test.ts
+++ b/packages/connections/src/llm-connections.test.ts
@@ -1,5 +1,6 @@
-import { llmConnections } from '@agile/db';
+import { auditLog, llmConnections } from '@agile/db';
 import type { LlmConfig } from '@agile/llm';
+import { desc, eq } from 'drizzle-orm';
 import { afterAll, beforeAll, describe, expect, it } from 'vitest';
 import {
   createLlmConnection,
@@ -124,14 +125,37 @@ describe('llm connections', () => {
     expect((await listLlmConnections(deps, 'org_race')).filter((c) => c.isDefault)).toHaveLength(1);
   });
 
-  it('is invisible to other orgs and deleting the default leaves none', async () => {
+  it('is invisible to other orgs; deleting the default promotes the most recent remaining one', async () => {
     expect(await listLlmConnections(deps, 'org_b')).toEqual([]);
     expect(await loadDefaultLlmConfig(deps, 'org_b')).toBeNull();
     const def = (await listLlmConnections(deps, 'org_a')).find((c) => c.isDefault);
+    expect(def?.label).toBe('Second');
     expect(await deleteLlmConnection(deps, owner('org_b'), def?.id ?? '')).toMatchObject({
       code: 'not_found',
     });
     expect(await deleteLlmConnection(deps, owner(), def?.id ?? '')).toEqual({ ok: true });
+    // 'Ollama' (added after 'Claude') is now the most recent remaining connection.
+    const after = await listLlmConnections(deps, 'org_a');
+    expect(after.filter((c) => c.isDefault).map((c) => c.label)).toEqual(['Ollama']);
+    expect(await loadDefaultLlmConfig(deps, 'org_a')).toMatchObject({
+      provider: 'openai_compatible',
+    });
+    const [audit] = await h.rawDb
+      .select()
+      .from(auditLog)
+      .where(eq(auditLog.action, 'llm_connection.default_changed'))
+      .orderBy(desc(auditLog.createdAt))
+      .limit(1);
+    expect(audit?.metadata).toEqual({ reason: 'previous_default_deleted' });
+  });
+
+  it('deleting a non-default connection keeps the default; deleting the last leaves none', async () => {
+    const claude = (await listLlmConnections(deps, 'org_a')).find((c) => c.label === 'Claude');
+    expect(await deleteLlmConnection(deps, owner(), claude?.id ?? '')).toEqual({ ok: true });
+    const [only] = await listLlmConnections(deps, 'org_a');
+    expect(only).toMatchObject({ label: 'Ollama', isDefault: true });
+    expect(await deleteLlmConnection(deps, owner(), only?.id ?? '')).toEqual({ ok: true });
+    expect(await listLlmConnections(deps, 'org_a')).toEqual([]);
     expect(await loadDefaultLlmConfig(deps, 'org_a')).toBeNull();
   });
 });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project connections src/llm-connections.test.ts`
Expected: FAIL — "deleting the default promotes the most recent remaining one": `expected [] to deeply equal [ 'Ollama' ]`.

- [ ] **Step 3: Implement the promotion**

```diff
diff --git a/packages/connections/src/llm-connections.ts b/packages/connections/src/llm-connections.ts
--- a/packages/connections/src/llm-connections.ts
+++ b/packages/connections/src/llm-connections.ts
@@ -271,11 +271,12 @@ export async function deleteLlmConnection(
 ): Promise<{ ok: true } | LlmServiceFailure> {
   assertCanManage(actor);
   return withOrg(deps.db, actor.orgId, async (tx) => {
-    const deleted = await tx
+    await lockOrgDefaults(tx, actor.orgId);
+    const [deleted] = await tx
       .delete(llmConnections)
       .where(eq(llmConnections.id, id))
-      .returning({ id: llmConnections.id });
-    if (deleted.length === 0) return notFound;
+      .returning({ id: llmConnections.id, isDefault: llmConnections.isDefault });
+    if (!deleted) return notFound;
     await recordAudit(tx, {
       orgId: actor.orgId,
       actorUserId: actor.userId,
@@ -283,6 +284,28 @@ export async function deleteLlmConnection(
       targetType: 'llm_connection',
       targetId: id,
     });
+    if (deleted.isDefault) {
+      // Keep the workspace usable: the most recently added remaining connection becomes the default.
+      const [next] = await tx
+        .select({ id: llmConnections.id })
+        .from(llmConnections)
+        .orderBy(desc(llmConnections.createdAt), desc(llmConnections.id))
+        .limit(1);
+      if (next) {
+        await tx
+          .update(llmConnections)
+          .set({ isDefault: true })
+          .where(eq(llmConnections.id, next.id));
+        await recordAudit(tx, {
+          orgId: actor.orgId,
+          actorUserId: actor.userId,
+          action: 'llm_connection.default_changed',
+          targetType: 'llm_connection',
+          targetId: next.id,
+          metadata: { reason: 'previous_default_deleted' },
+        });
+      }
+    }
     return { ok: true } as const;
   });
 }
```

- [ ] **Step 4: Run the connections suite**

Run: `pnpm vitest run --project connections`
Expected: PASS — 28 tests (llm-connections: 9).

- [ ] **Step 5: Confirmation dialog (shadcn `alert-dialog`)**

Run: `pnpm --filter @agile/web exec shadcn add alert-dialog --yes`
Expected: creates `src/components/ui/alert-dialog.tsx` (button.tsx skipped as identical); no new dependency.

`apps/web/src/components/confirm-delete-button.tsx`:
```tsx
'use client';

import { useTransition } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

export interface ConfirmDeleteLabels {
  trigger: string;
  title: string;
  description: string;
  confirm: string;
  cancel: string;
}

/** A "Remove" button that asks for confirmation (shadcn alert-dialog) before running the server action. */
export function ConfirmDeleteButton({
  onConfirm,
  labels,
}: {
  onConfirm: () => Promise<void>;
  labels: ConfirmDeleteLabels;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" disabled={pending}>
          {labels.trigger}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{labels.title}</AlertDialogTitle>
          <AlertDialogDescription>{labels.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{labels.cancel}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => startTransition(onConfirm)}>
            {labels.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

`apps/web/src/app/(app)/settings/jira/jira-connection-item.tsx` (the delete `<form>` becomes the dialog):
```tsx
import type { JiraConnectionView } from '@agile/connections';
import { Cloud, Server } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { ConfirmDeleteButton } from '@/components/confirm-delete-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { deleteJiraConnectionAction, retestJiraConnectionAction } from './actions';

export async function JiraConnectionItem({
  c,
  canManage,
}: {
  c: JiraConnectionView;
  canManage: boolean;
}) {
  const t = await getTranslations('jira');
  const status = { ok: t('connected'), error: t('failing'), untested: t('untested') }[c.status];
  const Icon = c.deployment === 'cloud' ? Cloud : Server;
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {c.name}
          <Badge
            variant={
              c.status === 'ok' ? 'default' : c.status === 'error' ? 'destructive' : 'secondary'
            }
          >
            {status}
          </Badge>
        </ItemTitle>
        <ItemDescription>
          {c.baseUrl}
          {c.accountName ? ` · ${c.accountName}` : ''}
        </ItemDescription>
        {c.lastError && (
          <p className="text-sm text-destructive">
            {t.has(`errors.${c.lastError}`) ? t(`errors.${c.lastError}`) : t('errors.unknown')}
          </p>
        )}
      </ItemContent>
      {canManage && (
        <ItemActions>
          <form action={retestJiraConnectionAction.bind(null, c.id)}>
            <Button variant="outline" size="sm">
              {t('retest')}
            </Button>
          </form>
          <ConfirmDeleteButton
            onConfirm={deleteJiraConnectionAction.bind(null, c.id)}
            labels={{
              trigger: t('delete'),
              title: t('deleteTitle'),
              description: t('deleteDescription', { name: c.name }),
              confirm: t('delete'),
              cancel: t('cancel'),
            }}
          />
        </ItemActions>
      )}
    </Item>
  );
}
```

`apps/web/src/app/(app)/settings/llm/llm-connection-item.tsx`:
```diff
diff --git a/apps/web/src/app/(app)/settings/llm/llm-connection-item.tsx b/apps/web/src/app/(app)/settings/llm/llm-connection-item.tsx
--- a/apps/web/src/app/(app)/settings/llm/llm-connection-item.tsx
+++ b/apps/web/src/app/(app)/settings/llm/llm-connection-item.tsx
@@ -1,6 +1,7 @@
 import type { LlmConnectionView } from '@agile/connections';
 import { Bot } from 'lucide-react';
 import { getTranslations } from 'next-intl/server';
+import { ConfirmDeleteButton } from '@/components/confirm-delete-button';
 import { Badge } from '@/components/ui/badge';
 import { Button } from '@/components/ui/button';
 import {
@@ -67,11 +68,16 @@ export async function LlmConnectionItem({
               {t('retest')}
             </Button>
           </form>
-          <form action={deleteLlmConnectionAction.bind(null, c.id)}>
-            <Button variant="ghost" size="sm">
-              {t('delete')}
-            </Button>
-          </form>
+          <ConfirmDeleteButton
+            onConfirm={deleteLlmConnectionAction.bind(null, c.id)}
+            labels={{
+              trigger: t('delete'),
+              title: t('deleteTitle'),
+              description: t('deleteDescription', { label: c.label }),
+              confirm: t('delete'),
+              cancel: t('cancel'),
+            }}
+          />
         </ItemActions>
       )}
     </Item>
```

Deep-merge into `apps/web/messages/en.json`:
```json
{
  "jira": {
    "deleteTitle": "Remove this Jira connection?",
    "deleteDescription": "{name} will be disconnected and everything synced from it deleted. This cannot be undone.",
    "cancel": "Cancel"
  },
  "llm": {
    "deleteTitle": "Remove this AI model?",
    "deleteDescription": "The key for {label} will be deleted. If it was the default, the most recently added model becomes the default.",
    "cancel": "Cancel"
  }
}
```

Deep-merge into `apps/web/messages/fr.json`:
```json
{
  "jira": {
    "deleteTitle": "Supprimer cette connexion Jira ?",
    "deleteDescription": "{name} sera déconnecté et tout ce qui en a été synchronisé sera supprimé. Cette action est irréversible.",
    "cancel": "Annuler"
  },
  "llm": {
    "deleteTitle": "Supprimer ce modèle d'IA ?",
    "deleteDescription": "La clé de {label} sera supprimée. S'il s'agissait du modèle par défaut, le modèle ajouté le plus récemment le remplace.",
    "cancel": "Annuler"
  }
}
```

- [ ] **Step 6: e2e — removal asks first**

Append to `e2e/tests/jira-connection.spec.ts`:
```diff
diff --git a/e2e/tests/jira-connection.spec.ts b/e2e/tests/jira-connection.spec.ts
--- a/e2e/tests/jira-connection.spec.ts
+++ b/e2e/tests/jira-connection.spec.ts
@@ -55,3 +55,25 @@ test('a private Jira address is explained in French', async ({ page }) => {
     ),
   ).toBeVisible();
 });
+
+test('removing a Jira connection asks for confirmation first', async ({ page }) => {
+  await signUpWithWorkspace(page);
+  await page.goto('/settings/jira');
+  await page.getByLabel('Connection name').fill('Corp Jira');
+  await page.getByLabel('Jira URL').fill('http://127.0.0.1:4010');
+  await page.getByLabel('Data Center / Server').check();
+  await page.getByLabel('Personal access token').fill('good-pat');
+  await page.getByRole('button', { name: 'Test and save' }).click();
+  const card = connectionItem(page, 'Corp Jira');
+  await expect(card.getByText('Connected')).toBeVisible();
+
+  await card.getByRole('button', { name: 'Remove' }).click();
+  const dialog = page.getByRole('alertdialog');
+  await expect(dialog.getByText('Remove this Jira connection?')).toBeVisible();
+  await dialog.getByRole('button', { name: 'Cancel' }).click();
+  await expect(card.getByText('Connected')).toBeVisible();
+
+  await card.getByRole('button', { name: 'Remove' }).click();
+  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
+  await expect(page.getByText('No Jira connected yet.')).toBeVisible();
+});
```

- [ ] **Step 7: Run lint, typecheck and the e2e suite**

Run (dev Postgres up: `docker compose up -d postgres`):
```bash
pnpm lint && pnpm typecheck
CI=true pnpm e2e
```
Expected: Biome/tsc clean; Playwright: all tests pass, including "removing a Jira connection asks for confirmation first". (`CI=true` uses the 30 s expect timeout; locally the first `next dev` compile of a page can exceed 5 s.)

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: promote the next LLM default on delete; confirm connection removal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 0.4: Deleting a workspace purges its tenant data

**Files:**
- Create: `packages/db/src/purge.ts`
- Modify: `packages/db/src/index.ts`, `packages/db/src/rls.test.ts`, `packages/auth/src/server.ts`, `packages/auth/src/auth.test.ts`

**Interfaces:**
- Produces (from `@agile/db`): `purgeOrgTenantRows(tx: Tx, orgId: string): Promise<string[]>` — deletes the org's rows from every public base table that has an `org_id` column **except `audit_log`**, discovered at run time (so Phase 2+ tables are covered automatically); returns the table names. Must run inside `withOrg(db, orgId, …)`.
- `createAuth(...)` now registers better-auth `organizationHooks.beforeDeleteOrganization`: inside one `withOrg` transaction it inserts an `audit_log` row `{ action: 'organization.deleted', targetType: 'organization', targetId: orgId, actorUserId }` and calls `purgeOrgTenantRows`.
- Schema guard added: every foreign key from a table with `org_id` is `ON DELETE CASCADE` (`confdeltype = 'c'`) — the purge deletes table by table in name order, which only works with cascades.

**Ruling — `audit_log` is kept.** The app role cannot delete from it (append-only since Phase 1), it never holds secrets, and it is the record that the workspace was deleted and by whom. Its retention (including GDPR erasure of a deleted workspace's rows) belongs to Phase 5's retention controls, run by the owner role. Cost if wrong: rows of deleted workspaces stay until Phase 5.

**Ruling — before, not after.** The purge runs in `beforeDeleteOrganization`: if it fails, better-auth does not delete the organisation, so encrypted secrets are never left behind without a workspace. If better-auth's own delete then fails, the workspace survives with its connections already removed — the user asked for deletion, so that is the safe side.

- [ ] **Step 1: Write the failing tests**

`packages/db/src/rls.test.ts` — add the `owner` connection, the FK guard and the purge test:
```diff
diff --git a/packages/db/src/rls.test.ts b/packages/db/src/rls.test.ts
--- a/packages/db/src/rls.test.ts
+++ b/packages/db/src/rls.test.ts
@@ -2,7 +2,8 @@ import { randomUUID } from 'node:crypto';
 import { sql } from 'drizzle-orm';
 import { afterAll, beforeAll, describe, expect, it } from 'vitest';
 import { createDb, withOrg } from './client';
-import { auditLog, jiraConnections } from './schema';
+import { purgeOrgTenantRows } from './purge';
+import { auditLog, jiraConnections, orgDataKeys } from './schema';
 import { startTestDatabase, type TestDatabase } from './testing';
 
 const pgMessage = (e: unknown): string =>
@@ -22,13 +23,16 @@ const connectionRow = (orgId: string) => ({
 describe('row-level security (as app_user)', () => {
   let tdb: TestDatabase;
   let app: ReturnType<typeof createDb>;
+  let owner: ReturnType<typeof createDb>; // bypasses RLS, to inspect raw rows
 
   beforeAll(async () => {
     tdb = await startTestDatabase();
     app = createDb(tdb.appUrl, { max: 1 }); // one connection: proves org context doesn't leak
+    owner = createDb(tdb.ownerUrl, { max: 1 });
   });
   afterAll(async () => {
     await app?.close();
+    await owner?.close();
     await tdb?.stop();
   });
 
@@ -84,6 +88,45 @@ describe('row-level security (as app_user)', () => {
     expect(unguarded).toEqual([]);
   });
 
+  it('guards the schema: foreign keys from tenant tables cascade on delete', async () => {
+    // purgeOrgTenantRows deletes table by table in any order, which only works with cascades.
+    const rows = (await app.db.execute(sql`
+      select con.conname as name, con.confdeltype as on_delete
+      from pg_constraint con
+      join pg_class rel on rel.oid = con.conrelid
+      join pg_namespace n on n.oid = rel.relnamespace
+      where con.contype = 'f' and n.nspname = 'public'
+        and exists (select 1 from information_schema.columns col
+          where col.table_schema = 'public' and col.table_name = rel.relname
+            and col.column_name = 'org_id')
+    `)) as unknown as { name: string; on_delete: string }[];
+    expect(rows.filter((r) => r.on_delete !== 'c')).toEqual([]);
+  });
+
+  it('purges one org from every tenant table except the audit log', async () => {
+    for (const org of ['org_p', 'org_q']) {
+      await withOrg(app.db, org, async (tx) => {
+        await tx.insert(jiraConnections).values(connectionRow(org));
+        await tx.insert(orgDataKeys).values({ orgId: org, kekVersion: 1, wrappedDek: 'w' });
+        await tx.insert(auditLog).values({ orgId: org, action: 'test' });
+      });
+    }
+    const purged = await withOrg(app.db, 'org_p', (tx) => purgeOrgTenantRows(tx, 'org_p'));
+    expect(purged).toEqual(
+      expect.arrayContaining(['jira_connections', 'llm_connections', 'org_data_keys']),
+    );
+    expect(purged).not.toContain('audit_log');
+
+    const count = async (org: string) =>
+      (await owner.db.execute(sql`
+        select (select count(*)::int from jira_connections where org_id = ${org}) as jira,
+               (select count(*)::int from org_data_keys where org_id = ${org}) as keys,
+               (select count(*)::int from audit_log where org_id = ${org}) as audit
+      `)) as unknown as { jira: number; keys: number; audit: number }[];
+    expect(await count('org_p')).toEqual([{ jira: 0, keys: 0, audit: 1 }]);
+    expect(await count('org_q')).toEqual([{ jira: 1, keys: 1, audit: 1 }]);
+  });
+
   it('refuses an empty org id', () => {
     expect(() => withOrg(app.db, '', async () => 1)).toThrow(/non-empty/);
   });
```

`packages/auth/src/auth.test.ts` — workspace deletion end to end:
```diff
diff --git a/packages/auth/src/auth.test.ts b/packages/auth/src/auth.test.ts
--- a/packages/auth/src/auth.test.ts
+++ b/packages/auth/src/auth.test.ts
@@ -1,5 +1,6 @@
-import { createDb } from '@agile/db';
+import { auditLog, createDb, orgDataKeys, withOrg } from '@agile/db';
 import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
+import { eq } from 'drizzle-orm';
 import { afterAll, beforeAll, describe, expect, it } from 'vitest';
 import { canManageConnections, getMemberRoles } from './roles';
 import { type Auth, createAuth } from './server';
@@ -79,6 +80,44 @@ describe('auth', () => {
     expect(session?.session.activeOrganizationId ?? null).toBeNull();
   });
 
+  it('deleting a workspace purges its tenant rows but keeps the audit trail', async () => {
+    const { headers } = await auth.api.signUpEmail({
+      body: { email: 'leaver@example.com', password: 'correct-horse-1', name: 'Lea' },
+      returnHeaders: true,
+    });
+    const h = cookieHeader(headers);
+    const doomed = await auth.api.createOrganization({
+      headers: h,
+      body: { name: 'Doomed', slug: 'doomed' },
+    });
+    const kept = await auth.api.createOrganization({
+      headers: h,
+      body: { name: 'Kept', slug: 'kept' },
+    });
+    const orgIds = [doomed?.id ?? '', kept?.id ?? ''];
+    for (const orgId of orgIds) {
+      await withOrg(conn.db, orgId, (tx) =>
+        tx.insert(orgDataKeys).values({ orgId, kekVersion: 1, wrappedDek: 'wrapped' }),
+      );
+    }
+
+    await auth.api.deleteOrganization({ headers: h, body: { organizationId: orgIds[0] ?? '' } });
+
+    const owner = createDb(tdb.ownerUrl, { max: 1 });
+    try {
+      const keys = await owner.db.select({ orgId: orgDataKeys.orgId }).from(orgDataKeys);
+      expect(keys.map((k) => k.orgId)).not.toContain(orgIds[0]);
+      expect(keys.map((k) => k.orgId)).toContain(orgIds[1]);
+      const audit = await owner.db
+        .select()
+        .from(auditLog)
+        .where(eq(auditLog.orgId, orgIds[0] ?? ''));
+      expect(audit).toMatchObject([{ action: 'organization.deleted', targetId: orgIds[0] }]);
+    } finally {
+      await owner.close();
+    }
+  });
+
   it('returns no roles for a non-member', async () => {
     expect(await getMemberRoles(conn.db, 'org_missing', 'user_missing')).toEqual([]);
     expect(canManageConnections(['member'])).toBe(false);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project db --project auth`
Expected: FAIL — `Cannot find module './purge'` (db); auth's new test fails because `org_data_keys` still holds the deleted workspace's key.

- [ ] **Step 3: Implement**

`packages/db/src/purge.ts`:
```ts
import { sql } from 'drizzle-orm';
import type { Tx } from './client';

/**
 * Deletes every row of one organisation from every tenant table (any public table with an
 * `org_id` column), except the append-only `audit_log`. Tables are discovered at run time, so
 * tables added in later phases are purged without touching this function. Run inside
 * `withOrg(db, orgId, …)`: RLS then confines the deletes to that org a second time.
 * Requires every foreign key between tenant tables to be ON DELETE CASCADE (schema guard test).
 */
export async function purgeOrgTenantRows(tx: Tx, orgId: string): Promise<string[]> {
  const tables = (await tx.execute(sql`
    select c.table_name as name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and c.column_name = 'org_id'
      and t.table_type = 'BASE TABLE' and c.table_name <> 'audit_log'
    order by c.table_name
  `)) as unknown as { name: string }[];
  for (const { name } of tables) {
    await tx.execute(sql`delete from ${sql.identifier(name)} where org_id = ${orgId}`);
  }
  return tables.map((t) => t.name);
}
```

`packages/db/src/index.ts`:
```ts
export { createDb, type Db, isUniqueViolation, type Tx, withOrg } from './client';
export { runMigrations } from './migrate';
export { purgeOrgTenantRows } from './purge';
export * from './schema';
```

`packages/auth/src/server.ts`:
```diff
diff --git a/packages/auth/src/server.ts b/packages/auth/src/server.ts
--- a/packages/auth/src/server.ts
+++ b/packages/auth/src/server.ts
@@ -1,5 +1,5 @@
-import type { Db } from '@agile/db';
 import * as schema from '@agile/db';
+import { auditLog, type Db, purgeOrgTenantRows, withOrg } from '@agile/db';
 import { betterAuth } from 'better-auth';
 import { drizzleAdapter } from 'better-auth/adapters/drizzle';
 import { nextCookies } from 'better-auth/next-js';
@@ -29,7 +29,30 @@ export function createAuth({ db, secret, baseURL }: AuthOptions) {
         },
       },
     },
-    plugins: [organization({ allowUserToCreateOrganization: true }), nextCookies()], // nextCookies last
+    plugins: [
+      organization({
+        allowUserToCreateOrganization: true,
+        organizationHooks: {
+          // Before, not after: if the purge fails the workspace is kept, so its encrypted secrets
+          // are never left behind without an owner.
+          beforeDeleteOrganization: async ({ organization: org, user }) => {
+            await withOrg(db, org.id, async (tx) => {
+              // audit_log is append-only (app_user cannot delete from it) and holds no secrets; it is
+              // kept as the record of the deletion. Retention purges arrive with Phase 5.
+              await tx.insert(auditLog).values({
+                orgId: org.id,
+                actorUserId: user.id,
+                action: 'organization.deleted',
+                targetType: 'organization',
+                targetId: org.id,
+              });
+              await purgeOrgTenantRows(tx, org.id);
+            });
+          },
+        },
+      }),
+      nextCookies(), // must stay last
+    ],
   });
 }
 
```

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `pnpm vitest run --project db --project auth && pnpm lint && pnpm typecheck`
Expected: PASS — db 8 tests, auth 5 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(auth): purge a workspace's tenant data when it is deleted

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 0.5: Route tests for `/api/jira/oauth/start` and `/callback`

**Files:**
- Create: `apps/web/vitest.config.ts`, `apps/web/src/app/api/jira/oauth/oauth-routes.test.ts`
- Modify: `vitest.config.ts` (root: add the `apps/web` project), `apps/web/src/app/api/jira/oauth/callback/route.ts` (role check found by the tests)

**Interfaces:**
- Web route handlers are unit-tested with `next/headers`, `@/server/context`, `@/server/atlassian` and `@agile/connections` mocked (`vi.mock` at top level); the routes are imported after the mocks with top-level `await import(...)`. The `@` alias resolves to `apps/web/src`.
- Callback contract: the state cookie is single-use (deleted before any check); a member (not owner/admin) is redirected with `error=forbidden_role` **before** the code is exchanged; state mismatch, missing cookie, missing code, a cookie without a workspace part, or a flow started in another workspace → `error=oauth_failed`; a service failure code is passed through; success → `connected=<created + updated>`.

- [ ] **Step 1: Test project and failing tests**

`apps/web/vitest.config.ts`:
```ts
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { name: 'web', environment: 'node', include: ['src/**/*.test.ts'] },
});
```

Root `vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/web'],
  },
});
```

`apps/web/src/app/api/jira/oauth/oauth-routes.test.ts`:
```ts
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route handlers run against stubs of the request cookies, the session and the OAuth service.
const jar = new Map<string, { value: string; options?: Record<string, unknown> }>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const c = jar.get(name);
      return c ? { name, value: c.value } : undefined;
    },
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      jar.set(name, { value, options });
    },
    delete: (opts: string | { name: string }) => {
      jar.delete(typeof opts === 'string' ? opts : opts.name);
    },
  }),
}));

const owner = {
  orgId: 'org_a',
  userId: 'user_1',
  roles: ['owner'],
  user: { id: 'user_1', name: 'Pat', email: 'pat@example.com' },
};
const requireActor = vi.fn(async () => owner);
vi.mock('@/server/context', () => ({
  requireActor: () => requireActor(),
  services: () => ({ env: { BETTER_AUTH_URL: 'http://localhost:3200' } }),
  connectionDeps: () => ({ deps: 'stub' }),
}));

const oauthClient = {
  createAuthorizationURL: (state: string) =>
    new URL(`https://auth.atlassian.com/authorize?state=${state}`),
};
let oauthConfigured = true;
vi.mock('@/server/atlassian', () => ({
  OAUTH_STATE_COOKIE: 'jira_oauth_state',
  atlassianOAuth: () => (oauthConfigured ? oauthClient : null),
}));

const completeJiraOAuth = vi.fn();
vi.mock('@agile/connections', () => ({
  completeJiraOAuth: (...args: unknown[]) => completeJiraOAuth(...args),
}));

const { GET: start } = await import('./start/route');
const { GET: callback } = await import('./callback/route');

const callbackRequest = (query: string) =>
  new NextRequest(`http://localhost:3200/api/jira/oauth/callback?${query}`);
const location = (res: Response) => res.headers.get('location');

describe('GET /api/jira/oauth/start', () => {
  beforeEach(() => {
    jar.clear();
    oauthConfigured = true;
    requireActor.mockResolvedValue(owner);
  });

  it('binds a fresh state to the active workspace and redirects to Atlassian', async () => {
    const res = await start();
    const cookie = jar.get('jira_oauth_state');
    const [state, orgId] = cookie?.value.split('.') ?? [];
    expect(orgId).toBe('org_a');
    expect(state).toMatch(/^[\w-]{20,}$/);
    expect(cookie?.options).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/api/jira/oauth',
      maxAge: 600,
      secure: false, // BETTER_AUTH_URL is http in this test
    });
    expect(location(res)).toBe(`https://auth.atlassian.com/authorize?state=${state}`);
  });

  it('sends members back without starting a flow', async () => {
    requireActor.mockResolvedValue({ ...owner, roles: ['member'] });
    const res = await start();
    expect(location(res)).toBe('http://localhost:3200/settings/jira?error=forbidden_role');
    expect(jar.size).toBe(0);
  });

  it('reports OAuth as unavailable when the app is not configured', async () => {
    oauthConfigured = false;
    const res = await start();
    expect(location(res)).toBe('http://localhost:3200/settings/jira?error=oauth_failed');
    expect(jar.size).toBe(0);
  });
});

describe('GET /api/jira/oauth/callback', () => {
  beforeEach(() => {
    jar.clear();
    oauthConfigured = true;
    requireActor.mockResolvedValue(owner);
    completeJiraOAuth.mockReset();
    completeJiraOAuth.mockResolvedValue({ ok: true, created: 2, updated: 1 });
  });

  const withState = (value: string) => jar.set('jira_oauth_state', { value });

  it('completes the flow for the workspace that started it', async () => {
    withState('st4te.org_a');
    const res = await callback(callbackRequest('code=c0de&state=st4te'));
    expect(location(res)).toBe('http://localhost:3200/settings/jira?connected=3');
    expect(completeJiraOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ deps: 'stub', oauth: oauthClient }),
      owner,
      'c0de',
    );
    expect(jar.has('jira_oauth_state')).toBe(false); // single use
  });

  it.each([
    ['a state that does not match the cookie', 'st4te.org_a', 'code=c0de&state=other'],
    ['a missing state cookie', undefined, 'code=c0de&state=st4te'],
    ['a missing code', 'st4te.org_a', 'state=st4te'],
    ['a flow started in another workspace', 'st4te.org_b', 'code=c0de&state=st4te'],
    ['a cookie without a workspace part', 'st4te', 'code=c0de&state=st4te'],
  ])('rejects %s', async (_case, cookie, query) => {
    if (cookie) withState(cookie);
    const res = await callback(callbackRequest(query));
    expect(location(res)).toBe('http://localhost:3200/settings/jira?error=oauth_failed');
    expect(completeJiraOAuth).not.toHaveBeenCalled();
    expect(jar.has('jira_oauth_state')).toBe(false);
  });

  it('keeps dots inside the workspace id (splits on the first dot only)', async () => {
    requireActor.mockResolvedValue({ ...owner, orgId: 'org.with.dots' });
    withState('st4te.org.with.dots');
    const res = await callback(callbackRequest('code=c0de&state=st4te'));
    expect(location(res)).toBe('http://localhost:3200/settings/jira?connected=3');
  });

  it('sends members back before exchanging the code', async () => {
    requireActor.mockResolvedValue({ ...owner, roles: ['member'] });
    withState('st4te.org_a');
    const res = await callback(callbackRequest('code=c0de&state=st4te'));
    expect(location(res)).toBe('http://localhost:3200/settings/jira?error=forbidden_role');
    expect(completeJiraOAuth).not.toHaveBeenCalled();
  });

  it('passes a service failure code through to the settings page', async () => {
    completeJiraOAuth.mockResolvedValue({ ok: false, code: 'oauth_no_sites' });
    withState('st4te.org_a');
    const res = await callback(callbackRequest('code=c0de&state=st4te'));
    expect(location(res)).toBe('http://localhost:3200/settings/jira?error=oauth_no_sites');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project web`
Expected: FAIL — 1 failed, 11 passed: "sends members back before exchanging the code" receives `…?connected=3` (today the callback calls `completeJiraOAuth`, which throws `ForbiddenError` → HTTP 500 for a real member).

- [ ] **Step 3: Fix the callback**

```diff
diff --git a/apps/web/src/app/api/jira/oauth/callback/route.ts b/apps/web/src/app/api/jira/oauth/callback/route.ts
--- a/apps/web/src/app/api/jira/oauth/callback/route.ts
+++ b/apps/web/src/app/api/jira/oauth/callback/route.ts
@@ -1,3 +1,4 @@
+import { canManageConnections } from '@agile/auth';
 import { completeJiraOAuth } from '@agile/connections';
 import { cookies } from 'next/headers';
 import { type NextRequest, NextResponse } from 'next/server';
@@ -10,6 +11,11 @@ export async function GET(request: NextRequest) {
   const jar = await cookies();
   const stored = jar.get(OAUTH_STATE_COOKIE)?.value ?? '';
   jar.delete({ name: OAUTH_STATE_COOKIE, path: '/api/jira/oauth' });
+  // Roles can change while the user is at Atlassian; check again before exchanging the code.
+  if (!canManageConnections(actor.roles)) {
+    back.searchParams.set('error', 'forbidden_role');
+    return NextResponse.redirect(back);
+  }
 
   // Cookie is `${state}.${orgId}`. arctic's state is base64url (never contains '.'), but org ids are
   // opaque and might, so split on the FIRST '.' only and keep the remainder as the org id.
```

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `pnpm vitest run --project web && pnpm lint && pnpm typecheck`
Expected: PASS — 12 tests. (`apps/web`'s tsconfig includes `src`, so the test file is type-checked too; `next build` ignores `*.test.ts`.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(web): route tests for the Atlassian OAuth start and callback; recheck role on callback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Part 1 — Data model, metrics, Jira data

### Task 1: Phase 2 schema — Jira data, status mapping, sync state, dashboards, pg-boss schema

**Files:**
- Create: `packages/db/src/schema/tenant.ts`, `packages/db/src/schema/jira-data.ts`, `packages/db/src/schema/dashboards.ts`
- Modify: `packages/db/src/schema/app.ts` (use the shared helpers), `packages/db/src/schema/index.ts`
- Generate: `packages/db/drizzle/0004_<generated>.sql` (+ meta), `packages/db/drizzle/0005_phase2_force_rls_and_pgboss.sql` (custom)
- Test: `packages/db/src/phase2-tables.test.ts`

**Interfaces (tables other tasks use; all have `org_id`, `tenantPolicy`, FORCE RLS):**
- `jiraBoards` — `id uuid`, `connectionId → jira_connections ON DELETE CASCADE`, `jiraBoardId int`, `name`, `type: 'scrum' | 'kanban' | 'simple'`, `projectKey`, `filterId`, `estimationFieldId`, `estimationFieldName`, `columns: BoardColumn[]` (`{ name; statusIds: string[] }`), `selected boolean`, `lastSyncedAt`; unique `(connection_id, jira_board_id)`. **Board selection = `selected`.**
- `jiraStatusMappings` — PK `(board_id, jira_status_id)`, `statusName`, `jiraCategory` (Jira's key: new/indeterminate/done/undefined), `category: 'todo' | 'in_progress' | 'done'`, `blocked boolean` (a waiting state), `source: 'auto' | 'user'`.
- `jiraSyncStates` — PK `connection_id`, `status: 'idle' | 'queued' | 'running' | 'ok' | 'error'`, `watermark`, `lastFullSyncAt`, `lastStartedAt`, `lastFinishedAt`, `lastSuccessAt`, `lastError` (a code).
- `jiraSyncRuns` — one row per run: `trigger: 'manual' | 'schedule'`, `mode: 'incremental' | 'full'`, `status`, `boardsSynced`, `issuesUpserted`, `error` (a code).
- `jiraIssues` — unique `(connection_id, jira_issue_id)`; `key`, `summary`, `issueType`, `isSubtask`, `statusId`, `assigneeId`, `assigneeName`, `estimate double`, `jiraCreatedAt`, `jiraUpdatedAt`, `resolvedAt`, `syncedAt`.
- `jiraBoardIssues` (PK board, issue), `jiraIssueTransitions` (PK issue, seq: `at`, `fromStatusId`, `toStatusId`), `jiraIssueChanges` (PK issue, seq: `kind: 'estimate' | 'flag'`, `fromValue`, `toValue`), `jiraSprints` (unique connection + `jiraSprintId`: `name`, `state: 'future' | 'active' | 'closed'`, `startAt`, `endAt`, `completeAt`, `goal`, `originBoardJiraId`), `jiraBoardSprints` (PK board, sprint), `jiraSprintIssues` (PK issue, `jiraSprintId`, `addedAt`; `removedAt`; keyed by the Jira sprint id so membership of sprints from unsynced boards needs no dangling FK).
- `dashboards` — `userId`, `boardId → jira_boards CASCADE`, `name`, `kind: 'scrum' | 'kanban' | 'custom'`, `position`, `widgets jsonb` (WidgetSpec[] from Task 11); partial unique index `(board_id, user_id, kind) WHERE kind <> 'custom'` (seeding defaults is idempotent).
- Schema `pgboss` owned by `app_user` (pg-boss installs its own tables there at runtime).
- Produces (shared schema helpers): `tenantPolicy(table, orgIdColumn)`, `createdAt`, `updatedAt` from `schema/tenant.ts`.

**Ruling — "equivalent" table names.** The spec names `issues`, `issue_transitions`, `sprints`, `sprint_membership`, `boards`. They are `jira_issues`, `jira_issue_transitions`, `jira_sprints`, `jira_sprint_issues`, `jira_boards` here (prefixed like `jira_connections`, so Phase 4+ can add other sources). Status *transitions* stay raw (Jira status ids) so a mapping change needs no re-sync. Estimate and flag history share `jira_issue_changes`.

**Ruling — pg-boss as `app_user`.** The web app must enqueue "Sync now" jobs and must not hold owner credentials. A migration creates `pgboss` owned by `app_user`; pg-boss (`createSchema: false`) creates and migrates its tables in it. Queue rows hold only ids (`orgId`, `connectionId`). Cost if wrong: if an operator requires the queue to be owner-managed, pg-boss would need its own role and connection string (a config change in `startSyncQueue`, no schema change).

- [ ] **Step 1: Write the failing test**

`packages/db/src/phase2-tables.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Tx, withOrg } from './client';
import { purgeOrgTenantRows } from './purge';
import {
  dashboards,
  jiraBoardIssues,
  jiraBoardSprints,
  jiraBoards,
  jiraConnections,
  jiraIssueChanges,
  jiraIssues,
  jiraIssueTransitions,
  jiraSprintIssues,
  jiraSprints,
  jiraStatusMappings,
  jiraSyncRuns,
  jiraSyncStates,
} from './schema';
import { startTestDatabase, type TestDatabase } from './testing';

const PHASE2_TABLES = [
  'dashboards',
  'jira_board_issues',
  'jira_board_sprints',
  'jira_boards',
  'jira_issue_changes',
  'jira_issue_transitions',
  'jira_issues',
  'jira_sprint_issues',
  'jira_sprints',
  'jira_status_mappings',
  'jira_sync_runs',
  'jira_sync_states',
];

/** One row in every Phase 2 table, all hanging off one new connection. */
async function seed(tx: Tx, orgId: string) {
  const connectionId = randomUUID();
  await tx.insert(jiraConnections).values({
    id: connectionId,
    orgId,
    name: 'Jira',
    deployment: 'datacenter',
    authType: 'pat',
    baseUrl: `https://jira.example/${connectionId}`,
    secret: 's1.x.y.z',
    createdBy: 'user_1',
  });
  const [board] = await tx
    .insert(jiraBoards)
    .values({ orgId, connectionId, jiraBoardId: 1, name: 'Board', type: 'scrum' })
    .returning();
  const [issue] = await tx
    .insert(jiraIssues)
    .values({
      orgId,
      connectionId,
      jiraIssueId: '10001',
      key: 'A-1',
      summary: 'Issue',
      issueType: 'Story',
      statusId: '1',
      jiraCreatedAt: new Date(),
      jiraUpdatedAt: new Date(),
    })
    .returning();
  const [sprint] = await tx
    .insert(jiraSprints)
    .values({ orgId, connectionId, jiraSprintId: 7, name: 'Sprint 7', state: 'active' })
    .returning();
  if (!board || !issue || !sprint) throw new Error('seed failed');
  await tx.insert(jiraStatusMappings).values({
    orgId,
    boardId: board.id,
    jiraStatusId: '1',
    statusName: 'To Do',
    jiraCategory: 'new',
    category: 'todo',
  });
  await tx.insert(jiraSyncStates).values({ orgId, connectionId });
  await tx.insert(jiraSyncRuns).values({ orgId, connectionId, trigger: 'manual', mode: 'full' });
  await tx.insert(jiraBoardIssues).values({ orgId, boardId: board.id, issueId: issue.id });
  await tx.insert(jiraIssueTransitions).values({
    orgId,
    issueId: issue.id,
    seq: 0,
    at: new Date(),
    fromStatusId: '1',
    toStatusId: '2',
  });
  await tx
    .insert(jiraIssueChanges)
    .values({ orgId, issueId: issue.id, seq: 1, at: new Date(), kind: 'estimate', toValue: '3' });
  await tx.insert(jiraBoardSprints).values({ orgId, boardId: board.id, sprintId: sprint.id });
  await tx
    .insert(jiraSprintIssues)
    .values({ orgId, connectionId, issueId: issue.id, jiraSprintId: 7, addedAt: new Date() });
  await tx
    .insert(dashboards)
    .values({ orgId, userId: 'user_1', boardId: board.id, name: 'Scrum', kind: 'scrum' });
}

describe('Phase 2 tenant tables (as app_user)', () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createDb>;
  let owner: ReturnType<typeof createDb>;

  const countAll = async (orgId: string) => {
    const counts: Record<string, number> = {};
    for (const table of PHASE2_TABLES) {
      const [row] = (await owner.db.execute(
        sql`select count(*)::int as n from ${sql.identifier(table)} where org_id = ${orgId}`,
      )) as unknown as { n: number }[];
      counts[table] = row?.n ?? -1;
    }
    return counts;
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = createDb(tdb.appUrl, { max: 1 });
    owner = createDb(tdb.ownerUrl, { max: 1 });
    await withOrg(app.db, 'org_a', (tx) => seed(tx, 'org_a'));
    await withOrg(app.db, 'org_b', (tx) => seed(tx, 'org_b'));
  });
  afterAll(async () => {
    await app?.close();
    await owner?.close();
    await tdb?.stop();
  });

  it('isolates every Phase 2 table by org', async () => {
    for (const table of PHASE2_TABLES) {
      const rows = (await withOrg(app.db, 'org_a', (tx) =>
        tx.execute(sql`select org_id from ${sql.identifier(table)}`),
      )) as unknown as { org_id: string }[];
      expect({ table, orgs: [...new Set(rows.map((r) => r.org_id))] }).toEqual({
        table,
        orgs: ['org_a'],
      });
    }
  });

  it('allows only one default dashboard of a kind per user and board', async () => {
    const [board] = await withOrg(app.db, 'org_a', (tx) => tx.select().from(jiraBoards));
    await expect(
      withOrg(app.db, 'org_a', (tx) =>
        tx.insert(dashboards).values({
          orgId: 'org_a',
          userId: 'user_1',
          boardId: board?.id ?? '',
          name: 'Scrum again',
          kind: 'scrum',
        }),
      ),
    ).rejects.toThrow();
  });

  it('purging an org empties every Phase 2 table for it and only it', async () => {
    await withOrg(app.db, 'org_a', (tx) => purgeOrgTenantRows(tx, 'org_a'));
    expect(Object.values(await countAll('org_a')).every((n) => n === 0)).toBe(true);
    expect(Object.values(await countAll('org_b')).every((n) => n === 1)).toBe(true);
  });

  it('lets the app role own the pg-boss schema', async () => {
    const [row] = (await owner.db.execute(sql`
      select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = 'pgboss'
    `)) as unknown as { owner: string }[];
    expect(row?.owner).toBe('app_user');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project db src/phase2-tables.test.ts`
Expected: FAIL — `dashboards`, `jiraBoards`, … are not exported by `./schema`.

- [ ] **Step 3: Shared helpers, new schema files**

`packages/db/src/schema/tenant.ts`:
```ts
import { sql } from 'drizzle-orm';
import { type AnyPgColumn, pgPolicy, timestamp } from 'drizzle-orm/pg-core';

/** Rows are visible/writable only when app.current_org_id (set by withOrg) matches. */
export const tenantPolicy = (table: string, orgId: AnyPgColumn) =>
  pgPolicy(`${table}_tenant_isolation`, {
    as: 'permissive',
    for: 'all',
    to: 'public',
    using: sql`${orgId} = current_setting('app.current_org_id', true)`,
    withCheck: sql`${orgId} = current_setting('app.current_org_id', true)`,
  });

export const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
export const updatedAt = timestamp('updated_at', { withTimezone: true })
  .notNull()
  .defaultNow()
  .$onUpdate(() => new Date());
```

`packages/db/src/schema/app.ts` — move the helpers out (no column changes):
```diff
diff --git a/packages/db/src/schema/app.ts b/packages/db/src/schema/app.ts
--- a/packages/db/src/schema/app.ts
+++ b/packages/db/src/schema/app.ts
@@ -1,34 +1,17 @@
 import { sql } from 'drizzle-orm';
 import {
-  type AnyPgColumn,
   boolean,
   index,
   integer,
   jsonb,
   pgEnum,
-  pgPolicy,
   pgTable,
   text,
   timestamp,
   uniqueIndex,
   uuid,
 } from 'drizzle-orm/pg-core';
-
-/** Rows are visible/writable only when app.current_org_id (set by withOrg) matches. */
-const tenantPolicy = (table: string, orgId: AnyPgColumn) =>
-  pgPolicy(`${table}_tenant_isolation`, {
-    as: 'permissive',
-    for: 'all',
-    to: 'public',
-    using: sql`${orgId} = current_setting('app.current_org_id', true)`,
-    withCheck: sql`${orgId} = current_setting('app.current_org_id', true)`,
-  });
-
-const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
-const updatedAt = timestamp('updated_at', { withTimezone: true })
-  .notNull()
-  .defaultNow()
-  .$onUpdate(() => new Date());
+import { createdAt, tenantPolicy, updatedAt } from './tenant';
 
 export const jiraDeployment = pgEnum('jira_deployment', ['cloud', 'datacenter']);
 export const jiraAuthType = pgEnum('jira_auth_type', ['basic', 'oauth', 'pat']);
```

`packages/db/src/schema/jira-data.ts`:
```ts
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { jiraConnections } from './app';
import { createdAt, tenantPolicy, updatedAt } from './tenant';

// Every table here hangs off jira_connections with ON DELETE CASCADE: removing a connection (or
// purging an org) removes everything synced from it.
const connectionRef = () =>
  uuid('connection_id')
    .notNull()
    .references(() => jiraConnections.id, { onDelete: 'cascade' });
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const jiraBoardType = pgEnum('jira_board_type', ['scrum', 'kanban', 'simple']);
export const statusCategory = pgEnum('status_category', ['todo', 'in_progress', 'done']);
export const statusMappingSource = pgEnum('status_mapping_source', ['auto', 'user']);
export const jiraSprintState = pgEnum('jira_sprint_state', ['future', 'active', 'closed']);
export const jiraIssueChangeKind = pgEnum('jira_issue_change_kind', ['estimate', 'flag']);
export const syncStatus = pgEnum('sync_status', ['idle', 'queued', 'running', 'ok', 'error']);
export const syncTrigger = pgEnum('sync_trigger', ['manual', 'schedule']);
export const syncMode = pgEnum('sync_mode', ['incremental', 'full']);

/** A board column and the Jira status ids it holds (from the board configuration). */
export interface BoardColumn {
  name: string;
  statusIds: string[];
}

export const jiraBoards = pgTable(
  'jira_boards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    connectionId: connectionRef(),
    jiraBoardId: integer('jira_board_id').notNull(),
    name: text('name').notNull(),
    type: jiraBoardType('type').notNull(),
    projectKey: text('project_key'),
    filterId: integer('filter_id'),
    /** Board estimation field (story points etc.); null when the board estimates by issue count. */
    estimationFieldId: text('estimation_field_id'),
    estimationFieldName: text('estimation_field_name'),
    columns: jsonb('columns').$type<BoardColumn[]>().notNull().default([]),
    /** Only selected boards are synced and get dashboards. */
    selected: boolean('selected').notNull().default(false),
    lastSyncedAt: ts('last_synced_at'),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex('jira_boards_connection_board_uq').on(t.connectionId, t.jiraBoardId),
    index('jira_boards_org_idx').on(t.orgId),
    tenantPolicy('jira_boards', t.orgId),
  ],
);

export const jiraStatusMappings = pgTable(
  'jira_status_mappings',
  {
    orgId: text('org_id').notNull(),
    boardId: uuid('board_id')
      .notNull()
      .references(() => jiraBoards.id, { onDelete: 'cascade' }),
    jiraStatusId: text('jira_status_id').notNull(),
    statusName: text('status_name').notNull(),
    /** Jira's own status category key: new | indeterminate | done | undefined. */
    jiraCategory: text('jira_category').notNull(),
    category: statusCategory('category').notNull(),
    /** Waiting/blocked statuses count as wait time in flow efficiency. */
    blocked: boolean('blocked').notNull().default(false),
    source: statusMappingSource('source').notNull().default('auto'),
    updatedAt,
  },
  (t) => [
    primaryKey({ columns: [t.boardId, t.jiraStatusId] }),
    tenantPolicy('jira_status_mappings', t.orgId),
  ],
);

export const jiraSyncStates = pgTable(
  'jira_sync_states',
  {
    connectionId: uuid('connection_id')
      .primaryKey()
      .references(() => jiraConnections.id, { onDelete: 'cascade' }),
    orgId: text('org_id').notNull(),
    status: syncStatus('status').notNull().default('idle'),
    /** Start time (our clock) of the last successful sync: the next incremental sync starts here. */
    watermark: ts('watermark'),
    lastFullSyncAt: ts('last_full_sync_at'),
    lastStartedAt: ts('last_started_at'),
    lastFinishedAt: ts('last_finished_at'),
    lastSuccessAt: ts('last_success_at'),
    /** A stable failure code (never raw error text, which could carry secrets). */
    lastError: text('last_error'),
    updatedAt,
  },
  (t) => [tenantPolicy('jira_sync_states', t.orgId)],
);

export const jiraSyncRuns = pgTable(
  'jira_sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    connectionId: connectionRef(),
    trigger: syncTrigger('trigger').notNull(),
    mode: syncMode('mode').notNull(),
    status: syncStatus('status').notNull().default('running'),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
    boardsSynced: integer('boards_synced').notNull().default(0),
    issuesUpserted: integer('issues_upserted').notNull().default(0),
    error: text('error'),
  },
  (t) => [
    index('jira_sync_runs_connection_started_idx').on(t.connectionId, t.startedAt),
    tenantPolicy('jira_sync_runs', t.orgId),
  ],
);

export const jiraIssues = pgTable(
  'jira_issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    connectionId: connectionRef(),
    jiraIssueId: text('jira_issue_id').notNull(),
    key: text('key').notNull(),
    summary: text('summary').notNull(),
    issueType: text('issue_type').notNull(),
    isSubtask: boolean('is_subtask').notNull().default(false),
    statusId: text('status_id').notNull(),
    assigneeId: text('assignee_id'),
    assigneeName: text('assignee_name'),
    estimate: doublePrecision('estimate'),
    jiraCreatedAt: ts('jira_created_at').notNull(),
    jiraUpdatedAt: ts('jira_updated_at').notNull(),
    resolvedAt: ts('resolved_at'),
    syncedAt: ts('synced_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('jira_issues_connection_issue_uq').on(t.connectionId, t.jiraIssueId),
    index('jira_issues_org_idx').on(t.orgId),
    tenantPolicy('jira_issues', t.orgId),
  ],
);

export const jiraBoardIssues = pgTable(
  'jira_board_issues',
  {
    orgId: text('org_id').notNull(),
    boardId: uuid('board_id')
      .notNull()
      .references(() => jiraBoards.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => jiraIssues.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.boardId, t.issueId] }),
    tenantPolicy('jira_board_issues', t.orgId),
  ],
);

/** Status changes from the issue changelog, in changelog order (seq). */
export const jiraIssueTransitions = pgTable(
  'jira_issue_transitions',
  {
    orgId: text('org_id').notNull(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => jiraIssues.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    at: ts('at').notNull(),
    fromStatusId: text('from_status_id'),
    toStatusId: text('to_status_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.seq] }),
    tenantPolicy('jira_issue_transitions', t.orgId),
  ],
);

/** Estimate and flag changes from the changelog (estimate values as text, flags as 'on'/'off'). */
export const jiraIssueChanges = pgTable(
  'jira_issue_changes',
  {
    orgId: text('org_id').notNull(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => jiraIssues.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    at: ts('at').notNull(),
    kind: jiraIssueChangeKind('kind').notNull(),
    fromValue: text('from_value'),
    toValue: text('to_value'),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.seq] }), tenantPolicy('jira_issue_changes', t.orgId)],
);

export const jiraSprints = pgTable(
  'jira_sprints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    connectionId: connectionRef(),
    jiraSprintId: integer('jira_sprint_id').notNull(),
    name: text('name').notNull(),
    state: jiraSprintState('state').notNull(),
    startAt: ts('start_at'),
    endAt: ts('end_at'),
    completeAt: ts('complete_at'),
    goal: text('goal'),
    originBoardJiraId: integer('origin_board_jira_id'),
  },
  (t) => [
    uniqueIndex('jira_sprints_connection_sprint_uq').on(t.connectionId, t.jiraSprintId),
    tenantPolicy('jira_sprints', t.orgId),
  ],
);

export const jiraBoardSprints = pgTable(
  'jira_board_sprints',
  {
    orgId: text('org_id').notNull(),
    boardId: uuid('board_id')
      .notNull()
      .references(() => jiraBoards.id, { onDelete: 'cascade' }),
    sprintId: uuid('sprint_id')
      .notNull()
      .references(() => jiraSprints.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.boardId, t.sprintId] }),
    tenantPolicy('jira_board_sprints', t.orgId),
  ],
);

/**
 * When an issue was in a sprint, derived from the Sprint field's changelog. Keyed by the Jira sprint
 * id, so membership of sprints from boards we don't sync is kept without a dangling reference.
 */
export const jiraSprintIssues = pgTable(
  'jira_sprint_issues',
  {
    orgId: text('org_id').notNull(),
    connectionId: connectionRef(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => jiraIssues.id, { onDelete: 'cascade' }),
    jiraSprintId: integer('jira_sprint_id').notNull(),
    addedAt: ts('added_at').notNull(),
    removedAt: ts('removed_at'),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.jiraSprintId, t.addedAt] }),
    index('jira_sprint_issues_sprint_idx').on(t.connectionId, t.jiraSprintId),
    tenantPolicy('jira_sprint_issues', t.orgId),
  ],
);
```

`packages/db/src/schema/dashboards.ts`:
```ts
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { jiraBoards } from './jira-data';
import { createdAt, tenantPolicy, updatedAt } from './tenant';

export const dashboardKind = pgEnum('dashboard_kind', ['scrum', 'kanban', 'custom']);

/** One user's dashboard for one board. `widgets` holds zod-validated WidgetSpec objects (@agile/dashboards). */
export const dashboards = pgTable(
  'dashboards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    userId: text('user_id').notNull(),
    boardId: uuid('board_id')
      .notNull()
      .references(() => jiraBoards.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: dashboardKind('kind').notNull(),
    position: integer('position').notNull().default(0),
    widgets: jsonb('widgets').$type<unknown[]>().notNull().default([]),
    createdAt,
    updatedAt,
  },
  (t) => [
    index('dashboards_owner_idx').on(t.orgId, t.userId, t.boardId),
    // At most one default dashboard of each kind per user and board (makes seeding idempotent).
    uniqueIndex('dashboards_default_uq')
      .on(t.boardId, t.userId, t.kind)
      .where(sql`${t.kind} <> 'custom'`),
    tenantPolicy('dashboards', t.orgId),
  ],
);
```

`packages/db/src/schema/index.ts`:
```ts
export * from './app';
export * from './auth';
export * from './dashboards';
export * from './jira-data';
```

- [ ] **Step 4: Generate the migrations (never edit generated SQL)**

Run:
```bash
pnpm db:generate
pnpm --filter @agile/db exec drizzle-kit generate --custom --name phase2_force_rls_and_pgboss
```
Expected: `packages/db/drizzle/0004_<random_name>.sql` — 9 `CREATE TYPE`, 12 `CREATE TABLE`, 12 `ENABLE ROW LEVEL SECURITY`, 15 cascade foreign keys, the indexes (including `dashboards_default_uq … WHERE "dashboards"."kind" <> 'custom'`) and 12 `CREATE POLICY` — and an empty `0005_phase2_force_rls_and_pgboss.sql`. For reference, the generated file reads:

```sql
CREATE TYPE "public"."dashboard_kind" AS ENUM('scrum', 'kanban', 'custom');--> statement-breakpoint
CREATE TYPE "public"."jira_board_type" AS ENUM('scrum', 'kanban', 'simple');--> statement-breakpoint
CREATE TYPE "public"."jira_issue_change_kind" AS ENUM('estimate', 'flag');--> statement-breakpoint
CREATE TYPE "public"."jira_sprint_state" AS ENUM('future', 'active', 'closed');--> statement-breakpoint
CREATE TYPE "public"."status_category" AS ENUM('todo', 'in_progress', 'done');--> statement-breakpoint
CREATE TYPE "public"."status_mapping_source" AS ENUM('auto', 'user');--> statement-breakpoint
CREATE TYPE "public"."sync_mode" AS ENUM('incremental', 'full');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('idle', 'queued', 'running', 'ok', 'error');--> statement-breakpoint
CREATE TYPE "public"."sync_trigger" AS ENUM('manual', 'schedule');--> statement-breakpoint
CREATE TABLE "dashboards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"board_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "dashboard_kind" NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"widgets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dashboards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jira_board_issues" (
	"org_id" text NOT NULL,
	"board_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	CONSTRAINT "jira_board_issues_board_id_issue_id_pk" PRIMARY KEY("board_id","issue_id")
);
--> statement-breakpoint
ALTER TABLE "jira_board_issues" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jira_board_sprints" (
	"org_id" text NOT NULL,
	"board_id" uuid NOT NULL,
	"sprint_id" uuid NOT NULL,
	CONSTRAINT "jira_board_sprints_board_id_sprint_id_pk" PRIMARY KEY("board_id","sprint_id")
);
--> statement-breakpoint
ALTER TABLE "jira_board_sprints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jira_boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"jira_board_id" integer NOT NULL,
	"name" text NOT NULL,
	"type" "jira_board_type" NOT NULL,
	"project_key" text,
	"filter_id" integer,
	"estimation_field_id" text,
	"estimation_field_name" text,
	"columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"selected" boolean DEFAULT false NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jira_boards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jira_issue_changes" (
	"org_id" text NOT NULL,
	"issue_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" "jira_issue_change_kind" NOT NULL,
	"from_value" text,
	"to_value" text,
	CONSTRAINT "jira_issue_changes_issue_id_seq_pk" PRIMARY KEY("issue_id","seq")
);
--> statement-breakpoint
ALTER TABLE "jira_issue_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jira_issue_transitions" (
	"org_id" text NOT NULL,
	"issue_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"from_status_id" text,
	"to_status_id" text NOT NULL,
	CONSTRAINT "jira_issue_transitions_issue_id_seq_pk" PRIMARY KEY("issue_id","seq")
);
--> statement-breakpoint
ALTER TABLE "jira_issue_transitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jira_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"jira_issue_id" text NOT NULL,
	"key" text NOT NULL,
	"summary" text NOT NULL,
	"issue_type" text NOT NULL,
	"is_subtask" boolean DEFAULT false NOT NULL,
	"status_id" text NOT NULL,
	"assignee_id" text,
	"assignee_name" text,
	"estimate" double precision,
	"jira_created_at" timestamp with time zone NOT NULL,
	"jira_updated_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jira_issues" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jira_sprint_issues" (
	"org_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"jira_sprint_id" integer NOT NULL,
	"added_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "jira_sprint_issues_issue_id_jira_sprint_id_added_at_pk" PRIMARY KEY("issue_id","jira_sprint_id","added_at")
);
--> statement-breakpoint
ALTER TABLE "jira_sprint_issues" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jira_sprints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"jira_sprint_id" integer NOT NULL,
	"name" text NOT NULL,
	"state" "jira_sprint_state" NOT NULL,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"complete_at" timestamp with time zone,
	"goal" text,
	"origin_board_jira_id" integer
);
--> statement-breakpoint
ALTER TABLE "jira_sprints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jira_status_mappings" (
	"org_id" text NOT NULL,
	"board_id" uuid NOT NULL,
	"jira_status_id" text NOT NULL,
	"status_name" text NOT NULL,
	"jira_category" text NOT NULL,
	"category" "status_category" NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"source" "status_mapping_source" DEFAULT 'auto' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jira_status_mappings_board_id_jira_status_id_pk" PRIMARY KEY("board_id","jira_status_id")
);
--> statement-breakpoint
ALTER TABLE "jira_status_mappings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jira_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"trigger" "sync_trigger" NOT NULL,
	"mode" "sync_mode" NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"boards_synced" integer DEFAULT 0 NOT NULL,
	"issues_upserted" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "jira_sync_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jira_sync_states" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"status" "sync_status" DEFAULT 'idle' NOT NULL,
	"watermark" timestamp with time zone,
	"last_full_sync_at" timestamp with time zone,
	"last_started_at" timestamp with time zone,
	"last_finished_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jira_sync_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_board_id_jira_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."jira_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_board_issues" ADD CONSTRAINT "jira_board_issues_board_id_jira_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."jira_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_board_issues" ADD CONSTRAINT "jira_board_issues_issue_id_jira_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."jira_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_board_sprints" ADD CONSTRAINT "jira_board_sprints_board_id_jira_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."jira_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_board_sprints" ADD CONSTRAINT "jira_board_sprints_sprint_id_jira_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."jira_sprints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_boards" ADD CONSTRAINT "jira_boards_connection_id_jira_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."jira_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_issue_changes" ADD CONSTRAINT "jira_issue_changes_issue_id_jira_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."jira_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_issue_transitions" ADD CONSTRAINT "jira_issue_transitions_issue_id_jira_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."jira_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_issues" ADD CONSTRAINT "jira_issues_connection_id_jira_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."jira_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_sprint_issues" ADD CONSTRAINT "jira_sprint_issues_connection_id_jira_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."jira_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_sprint_issues" ADD CONSTRAINT "jira_sprint_issues_issue_id_jira_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."jira_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_sprints" ADD CONSTRAINT "jira_sprints_connection_id_jira_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."jira_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_status_mappings" ADD CONSTRAINT "jira_status_mappings_board_id_jira_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."jira_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_sync_runs" ADD CONSTRAINT "jira_sync_runs_connection_id_jira_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."jira_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_sync_states" ADD CONSTRAINT "jira_sync_states_connection_id_jira_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."jira_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboards_owner_idx" ON "dashboards" USING btree ("org_id","user_id","board_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboards_default_uq" ON "dashboards" USING btree ("board_id","user_id","kind") WHERE "dashboards"."kind" <> 'custom';--> statement-breakpoint
CREATE UNIQUE INDEX "jira_boards_connection_board_uq" ON "jira_boards" USING btree ("connection_id","jira_board_id");--> statement-breakpoint
CREATE INDEX "jira_boards_org_idx" ON "jira_boards" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jira_issues_connection_issue_uq" ON "jira_issues" USING btree ("connection_id","jira_issue_id");--> statement-breakpoint
CREATE INDEX "jira_issues_org_idx" ON "jira_issues" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "jira_sprint_issues_sprint_idx" ON "jira_sprint_issues" USING btree ("connection_id","jira_sprint_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jira_sprints_connection_sprint_uq" ON "jira_sprints" USING btree ("connection_id","jira_sprint_id");--> statement-breakpoint
CREATE INDEX "jira_sync_runs_connection_started_idx" ON "jira_sync_runs" USING btree ("connection_id","started_at");--> statement-breakpoint
CREATE POLICY "dashboards_tenant_isolation" ON "dashboards" AS PERMISSIVE FOR ALL TO public USING ("dashboards"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("dashboards"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "jira_board_issues_tenant_isolation" ON "jira_board_issues" AS PERMISSIVE FOR ALL TO public USING ("jira_board_issues"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("jira_board_issues"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "jira_board_sprints_tenant_isolation" ON "jira_board_sprints" AS PERMISSIVE FOR ALL TO public USING ("jira_board_sprints"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("jira_board_sprints"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "jira_boards_tenant_isolation" ON "jira_boards" AS PERMISSIVE FOR ALL TO public USING ("jira_boards"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("jira_boards"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "jira_issue_changes_tenant_isolation" ON "jira_issue_changes" AS PERMISSIVE FOR ALL TO public USING ("jira_issue_changes"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("jira_issue_changes"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "jira_issue_transitions_tenant_isolation" ON "jira_issue_transitions" AS PERMISSIVE FOR ALL TO public USING ("jira_issue_transitions"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("jira_issue_transitions"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "jira_issues_tenant_isolation" ON "jira_issues" AS PERMISSIVE FOR ALL TO public USING ("jira_issues"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("jira_issues"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "jira_sprint_issues_tenant_isolation" ON "jira_sprint_issues" AS PERMISSIVE FOR ALL TO public USING ("jira_sprint_issues"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("jira_sprint_issues"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "jira_sprints_tenant_isolation" ON "jira_sprints" AS PERMISSIVE FOR ALL TO public USING ("jira_sprints"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("jira_sprints"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "jira_status_mappings_tenant_isolation" ON "jira_status_mappings" AS PERMISSIVE FOR ALL TO public USING ("jira_status_mappings"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("jira_status_mappings"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "jira_sync_runs_tenant_isolation" ON "jira_sync_runs" AS PERMISSIVE FOR ALL TO public USING ("jira_sync_runs"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("jira_sync_runs"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "jira_sync_states_tenant_isolation" ON "jira_sync_states" AS PERMISSIVE FOR ALL TO public USING ("jira_sync_states"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("jira_sync_states"."org_id" = current_setting('app.current_org_id', true));
```

Replace the contents of `packages/db/drizzle/0005_phase2_force_rls_and_pgboss.sql` with:
```sql
ALTER TABLE jira_boards FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jira_status_mappings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jira_sync_states FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jira_sync_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jira_issues FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jira_board_issues FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jira_issue_transitions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jira_issue_changes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jira_sprints FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jira_board_sprints FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jira_sprint_issues FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE dashboards FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- pg-boss (job queue) keeps its tables in its own schema, owned by the app role so the web app and
-- worker can install and migrate it at startup (they run pg-boss with createSchema: false).
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION app_user;
```

The default privileges granted in `0001_app_role_grants.sql` already give `app_user` DML on the new tables. Check nothing is left: `pnpm --filter @agile/db exec drizzle-kit generate` prints `No schema changes, nothing to migrate`.

- [ ] **Step 5: Run the db suite (schema guards included), lint, typecheck**

Run: `pnpm vitest run --project db && pnpm lint && pnpm typecheck`
Expected: PASS — 12 tests (8 rls incl. the FORCE-RLS and cascade guards over the 12 new tables, 4 phase2-tables).

- [ ] **Step 6: Apply to the dev database**

Run: `docker compose up -d postgres && pnpm db:migrate`
Expected: `Migrations applied`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(db): Phase 2 tenant tables for Jira data, sync state and dashboards

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `@agile/metrics` — dataset model and Scrum metrics

**Files:**
- Create: `packages/metrics/{package.json,tsconfig.json,vitest.config.ts}`, `packages/metrics/src/{model,time,stats,issue,scrum,index}.ts`, `packages/metrics/src/fixtures.ts`
- Test: `packages/metrics/src/scrum.test.ts`

**Interfaces:**
- Model: `StatusCategory`, `StatusPeriod { from; category; blocked }`, `Interval { from; to | null }`, `EstimateChange { at; from; to }`, `MetricIssue { id; key; summary; type; createdAt; updatedAt; assignee; estimate; estimateChanges; statusPeriods; flagged }`, `SprintMember { issueId; addedAt; removedAt }`, `MetricSprint { id; name; state; startAt; endAt; completeAt; members }`, `BoardDataset { issues; sprints; hasEstimates }`, `Unit = 'points' | 'issues'`.
- Scrum: `velocity(ds, { sprints?: 6, unit?: 'points' }): SprintVelocity[]` (closed sprints, oldest first), `velocitySummary(rows): { average: number | null; sayDoRatio: number | null }`, `scopeChange(ds, sprint, { unit?, now }): ScopeChange | null`, `carryOver(ds, sprint): CarryOver | null`, `sprintBurn(ds, sprint, { unit?, now }): BurnRow[]` (`{ day; remaining; ideal; scope; completed }`), `currentSprint(ds)` (active, else last closed), `lastClosedSprint(ds)`.
- Helpers: `categoryAt`, `currentCategory`, `cycleStart`, `doneAt`, `estimateAt`, `percentile`, `addDays`, `DAY`, `isoDay`, `startOfUtcDay`.

**Definitions (the golden tests pin them):**
- *Committed* = issues in the sprint at `startAt`, valued with their estimate at `startAt`. *Completed* = issues in the sprint 1 ms before `completeAt` and done at `completeAt`, valued at `completeAt` (added scope included) — Jira's sprint-report semantics, robust to Jira moving unfinished issues out at close.
- *Scope added/removed* = membership intervals starting/ending strictly inside (start, close-or-now).
- *Carry-over* = in the sprint just before close and not done at close.
- *Burndown/burnup* = sampled at the end of each UTC day (capped at close, or `now` for an active sprint; later days are `null`); ideal = straight line from the committed total to 0 at the planned end.
- Unestimated issues are worth 0 points; `unit: 'issues'` counts issues.

- [ ] **Step 1: Package skeleton**

`packages/metrics/package.json` (pure-rand is used by Task 3's forecasts):
```json
{
  "name": "@agile/metrics",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "pure-rand": "8.4.2"
  }
}
```

`packages/metrics/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

`packages/metrics/vitest.config.ts`:
```ts
import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'metrics', environment: 'node', include: ['src/**/*.test.ts'] },
});
```

- [ ] **Step 2: Golden fixtures and failing tests**

`packages/metrics/src/fixtures.ts` (both fixtures; `flowFixture` is used by Task 3):
```ts
// Hand-built datasets for the golden tests. Every expected number in the tests is derived in the
// comments next to it from these definitions.
import type { EstimateChange, Interval, MetricIssue, MetricSprint, StatusCategory } from './model';
import { DAY, HOUR } from './time';

/** Monday 2026-01-05 00:00 UTC. */
export const T0 = Date.UTC(2026, 0, 5);
export const d = (day: number, hour = 0): Date => new Date(T0 + day * DAY + hour * HOUR);

type Step = [at: Date, category: StatusCategory, blocked?: boolean];

export function issue(
  key: string,
  opts: {
    created: Date;
    steps?: Step[];
    estimate?: number | null;
    estimateChanges?: EstimateChange[];
    flagged?: Interval[];
    assignee?: string | null;
    updated?: Date;
  },
): MetricIssue {
  return {
    id: key,
    key,
    summary: `Summary of ${key}`,
    type: 'Story',
    createdAt: opts.created,
    updatedAt: opts.updated ?? opts.created,
    assignee: opts.assignee === undefined ? 'pat' : opts.assignee,
    estimate: opts.estimate ?? null,
    estimateChanges: opts.estimateChanges ?? [],
    statusPeriods: [
      { from: opts.created, category: 'todo', blocked: false },
      ...(opts.steps ?? []).map(([from, category, blocked]) => ({
        from,
        category,
        blocked: blocked ?? false,
      })),
    ],
    flagged: opts.flagged ?? [],
  };
}

/**
 * One closed sprint, day 0 09:00 → day 10 09:00 (closed on time).
 * A 5 pts  committed, in progress d1, done d3
 * B 3 pts  committed (estimated 2 until d5), in progress d2, done d8
 * C 8 pts  committed, in progress d4, never done            → carried over
 * D 2 pts  committed, removed from the sprint d5            → scope removed
 * E 1 pt   created and added d4 12:00, in progress d5, done d6 → scope added
 */
export function scrumFixture() {
  const added = (id: string, at: Date, removedAt: Date | null = null) => ({
    issueId: id,
    addedAt: at,
    removedAt,
  });
  const issues = [
    issue('A', {
      created: d(-3),
      estimate: 5,
      steps: [
        [d(1), 'in_progress'],
        [d(3), 'done'],
      ],
    }),
    issue('B', {
      created: d(-3),
      estimate: 3,
      estimateChanges: [{ at: d(5), from: 2, to: 3 }],
      steps: [
        [d(2), 'in_progress'],
        [d(8), 'done'],
      ],
    }),
    issue('C', { created: d(-3), estimate: 8, steps: [[d(4), 'in_progress']] }),
    issue('D', { created: d(-3), estimate: 2 }),
    issue('E', {
      created: d(4, 12),
      estimate: 1,
      steps: [
        [d(5), 'in_progress'],
        [d(6), 'done'],
      ],
    }),
  ];
  const sprint: MetricSprint = {
    id: 's1',
    name: 'Sprint 1',
    state: 'closed',
    startAt: d(0, 9),
    endAt: d(10, 9),
    completeAt: d(10, 9),
    members: [
      added('A', d(-1)),
      added('B', d(-1)),
      added('C', d(-1)),
      added('D', d(-1), d(5)),
      added('E', d(4, 12)),
    ],
  };
  return { issues, sprints: [sprint], hasEstimates: true };
}

/**
 * Kanban board, observed at now = d30 (Wednesday 2026-02-04).
 * K1 created d0, in progress d2, done d4                       cycle 2, lead 4
 * K2 created d1, in progress d3, Blocked d5, in progress d7,
 *    flagged d8→d9, done d11                                   cycle 8, lead 10, blocked 3
 * K3 created d2, done d6 straight from to-do                   no cycle time, lead 4
 * K4 created d5, in progress d6, done d26                      cycle 20, lead 21
 * K5 created d10, in progress d20, last updated d10, 21 pts    in progress (stale, oversized)
 * K6 created d12, in progress d28, unassigned, 3 pts           in progress
 * K7 created d29, unestimated                                  to do
 */
export function flowFixture() {
  const issues = [
    issue('K1', {
      created: d(0),
      estimate: 1,
      steps: [
        [d(2), 'in_progress'],
        [d(4), 'done'],
      ],
    }),
    issue('K2', {
      created: d(1),
      estimate: 3,
      flagged: [{ from: d(8), to: d(9) }],
      steps: [
        [d(3), 'in_progress'],
        [d(5), 'in_progress', true],
        [d(7), 'in_progress'],
        [d(11), 'done'],
      ],
    }),
    issue('K3', { created: d(2), estimate: 1, steps: [[d(6), 'done']] }),
    issue('K4', {
      created: d(5),
      estimate: 5,
      steps: [
        [d(6), 'in_progress'],
        [d(26), 'done'],
      ],
    }),
    issue('K5', {
      created: d(10),
      estimate: 21,
      updated: d(10),
      steps: [[d(20), 'in_progress']],
    }),
    issue('K6', {
      created: d(12),
      estimate: 3,
      assignee: null,
      updated: d(28),
      steps: [[d(28), 'in_progress']],
    }),
    issue('K7', { created: d(29), updated: d(29) }),
  ];
  return { issues, sprints: [], hasEstimates: true };
}
```

`packages/metrics/src/scrum.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { d, scrumFixture } from './fixtures';
import {
  carryOver,
  currentSprint,
  scopeChange,
  sprintBurn,
  velocity,
  velocitySummary,
} from './scrum';

describe('scrum metrics (golden: scrumFixture)', () => {
  const ds = scrumFixture();
  const sprint = ds.sprints[0];
  if (!sprint) throw new Error('fixture');

  it('velocity: committed at start vs completed at close', () => {
    // committed = A5 + B2 (estimate at start) + C8 + D2 = 17
    // completed = done at close among A, B, C, E (D left): A5 + B3 (estimate at close) + E1 = 9
    expect(velocity(ds)).toEqual([
      {
        sprintId: 's1',
        name: 'Sprint 1',
        committed: 17,
        completed: 9,
        committedCount: 4,
        completedCount: 3,
      },
    ]);
    expect(velocity(ds, { unit: 'issues' })[0]).toMatchObject({ committed: 4, completed: 3 });
    expect(velocitySummary(velocity(ds))).toEqual({ average: 9, sayDoRatio: 0.5294 });
  });

  it('ignores sprints that are not closed', () => {
    const active = { ...sprint, id: 's2', state: 'active' as const, completeAt: null };
    expect(velocity({ ...ds, sprints: [active] })).toEqual([]);
    expect(velocitySummary([])).toEqual({ average: null, sayDoRatio: null });
  });

  it('scope change: E added (1 pt), D removed (2 pts)', () => {
    expect(scopeChange(ds, sprint, { now: d(20) })).toEqual({
      sprintId: 's1',
      name: 'Sprint 1',
      committed: 17,
      added: 1,
      removed: 2,
      addedCount: 1,
      removedCount: 1,
    });
  });

  it('carry-over: C was still open at close', () => {
    expect(carryOver(ds, sprint)).toEqual({
      sprintId: 's1',
      name: 'Sprint 1',
      count: 1,
      points: 8,
      issueKeys: ['C'],
    });
  });

  it('burndown and burnup, sampled at the end of each day', () => {
    const rows = sprintBurn(ds, sprint, { now: d(20) });
    // day: remaining (scope - completed); ideal = 17 × (1 - i/10)
    expect(rows.map((r) => [r.day, r.remaining, r.ideal, r.scope, r.completed])).toEqual([
      ['2026-01-05', 17, 17, 17, 0],
      ['2026-01-06', 17, 15.3, 17, 0],
      ['2026-01-07', 17, 13.6, 17, 0], // A is done at d3 00:00, after this day ends
      ['2026-01-08', 12, 11.9, 17, 5],
      ['2026-01-09', 13, 10.2, 18, 5], // E added (1)
      ['2026-01-10', 12, 8.5, 17, 5], // D removed (-2), B re-estimated 2 → 3 (+1)
      ['2026-01-11', 11, 6.8, 17, 6], // E done
      ['2026-01-12', 11, 5.1, 17, 6],
      ['2026-01-13', 8, 3.4, 17, 9], // B done
      ['2026-01-14', 8, 1.7, 17, 9],
      ['2026-01-15', 8, 0, 17, 9], // sampled at the close, 09:00
    ]);
  });

  it('leaves future days of an active sprint empty', () => {
    const active = { ...sprint, state: 'active' as const, completeAt: null };
    const rows = sprintBurn({ ...ds, sprints: [active] }, active, { now: d(3, 12) });
    expect(rows.slice(2, 5).map((r) => r.remaining)).toEqual([17, 12, null]);
    expect(currentSprint({ ...ds, sprints: [active] })?.id).toBe('s1');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm install && pnpm vitest run --project metrics`
Expected: FAIL — `Cannot find module './scrum'` (and `./time`, imported by the fixtures).

- [ ] **Step 4: Implement**

`packages/metrics/src/model.ts`:
```ts
/** Board-agnostic workflow bucket every Jira status is mapped to. */
export type StatusCategory = 'todo' | 'in_progress' | 'done';

/** The issue sat in `category` from `from` until the next period starts. */
export interface StatusPeriod {
  from: Date;
  category: StatusCategory;
  /** The mapped status is a waiting/blocked state (counts as wait time in flow efficiency). */
  blocked: boolean;
}

export interface Interval {
  from: Date;
  /** null = still open */
  to: Date | null;
}

export interface EstimateChange {
  at: Date;
  from: number | null;
  to: number | null;
}

export interface MetricIssue {
  id: string;
  key: string;
  summary: string;
  type: string;
  createdAt: Date;
  updatedAt: Date;
  assignee: string | null;
  /** Current estimate (story points or the board's estimation field); null = not estimated. */
  estimate: number | null;
  /** Ascending. Used to know the estimate at sprint start/end. */
  estimateChanges: EstimateChange[];
  /** Ascending, non-empty; the first period starts at createdAt. */
  statusPeriods: StatusPeriod[];
  /** Times the issue was flagged (Jira "Impediment"). */
  flagged: Interval[];
}

export interface SprintMember {
  issueId: string;
  addedAt: Date;
  removedAt: Date | null;
}

export interface MetricSprint {
  id: string;
  name: string;
  state: 'future' | 'active' | 'closed';
  startAt: Date | null;
  endAt: Date | null;
  completeAt: Date | null;
  members: SprintMember[];
}

export interface BoardDataset {
  issues: MetricIssue[];
  sprints: MetricSprint[];
  /** The board has an estimation field (story points); false for count-based boards. */
  hasEstimates: boolean;
}

export type Unit = 'points' | 'issues';
```

`packages/metrics/src/time.ts`:
```ts
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

// Day buckets are UTC calendar days (per-workspace time zones are a later setting).
export const startOfUtcDay = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * DAY);

/** yyyy-mm-dd of the UTC day. */
export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** Monday 00:00 UTC of the ISO week containing d. */
export const startOfUtcWeek = (d: Date): Date => {
  const day = startOfUtcDay(d);
  return addDays(day, -((day.getUTCDay() + 6) % 7));
};

/** Start of every UTC day from from's day through to's day, inclusive. */
export function eachUtcDay(from: Date, to: Date): Date[] {
  const days: Date[] = [];
  for (let d = startOfUtcDay(from); d.getTime() <= to.getTime(); d = addDays(d, 1)) days.push(d);
  return days;
}

/** Last instant of the day starting at dayStart, capped at `cap`. */
export const endOfDayCapped = (dayStart: Date, cap: Date): Date =>
  new Date(Math.min(dayStart.getTime() + DAY - 1, cap.getTime()));

export const toDays = (ms: number): number => ms / DAY;
```

`packages/metrics/src/stats.ts`:
```ts
import type { Interval } from './model';

/**
 * Nearest-rank percentile: the smallest value with at least p% of values at or below it.
 * Chosen because it always returns an observed value and is easy to verify by hand.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? null;
}

export const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

export const round = (value: number, digits = 2): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

/** Total milliseconds covered by the union of the intervals, clipped to [from, to]. */
export function coveredMs(intervals: readonly Interval[], from: Date, to: Date): number {
  const clipped = intervals
    .map((i) => ({
      start: Math.max(i.from.getTime(), from.getTime()),
      end: Math.min((i.to ?? to).getTime(), to.getTime()),
    }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = Number.NaN;
  let curEnd = Number.NaN;
  for (const i of clipped) {
    if (Number.isNaN(curStart) || i.start > curEnd) {
      if (!Number.isNaN(curStart)) total += curEnd - curStart;
      curStart = i.start;
      curEnd = i.end;
    } else {
      curEnd = Math.max(curEnd, i.end);
    }
  }
  if (!Number.isNaN(curStart)) total += curEnd - curStart;
  return total;
}
```

`packages/metrics/src/issue.ts`:
```ts
import type {
  Interval,
  MetricIssue,
  MetricSprint,
  StatusCategory,
  StatusPeriod,
  Unit,
} from './model';

const t = (d: Date) => d.getTime();

/** The status period the issue was in at `at`; undefined before the issue existed. */
export function periodAt(issue: MetricIssue, at: Date): StatusPeriod | undefined {
  let found: StatusPeriod | undefined;
  for (const p of issue.statusPeriods) {
    if (t(p.from) <= t(at)) found = p;
    else break;
  }
  return t(at) < t(issue.createdAt) ? undefined : found;
}

export const categoryAt = (issue: MetricIssue, at: Date): StatusCategory | undefined =>
  periodAt(issue, at)?.category;

export const currentCategory = (issue: MetricIssue): StatusCategory =>
  issue.statusPeriods.at(-1)?.category ?? 'todo';

/** Estimate in force at `at` (the value before the first change, if `at` precedes all changes). */
export function estimateAt(issue: MetricIssue, at: Date): number | null {
  if (issue.estimateChanges.length === 0) return issue.estimate;
  let value = issue.estimateChanges[0]?.from ?? null;
  for (const c of issue.estimateChanges) {
    if (t(c.at) <= t(at)) value = c.to;
    else break;
  }
  return value;
}

/** Worth of an issue at a moment: its estimate (unestimated = 0) or 1 when counting issues. */
export const valueAt = (issue: MetricIssue, at: Date, unit: Unit): number =>
  unit === 'issues' ? 1 : (estimateAt(issue, at) ?? 0);

/** First time the issue entered an in-progress status. */
export const cycleStart = (issue: MetricIssue): Date | null =>
  issue.statusPeriods.find((p) => p.category === 'in_progress')?.from ?? null;

/** Start of the final done period, when the issue is done now. */
export function doneAt(issue: MetricIssue): Date | null {
  const last = issue.statusPeriods.at(-1);
  return last?.category === 'done' ? last.from : null;
}

/** Times the issue spent in a blocked status (as intervals). */
export function blockedStatusIntervals(issue: MetricIssue): Interval[] {
  return issue.statusPeriods.flatMap((p, i) =>
    p.blocked ? [{ from: p.from, to: issue.statusPeriods[i + 1]?.from ?? null }] : [],
  );
}

/** Ids of the issues that were in the sprint at `at`. */
export function membersAt(sprint: MetricSprint, at: Date): Set<string> {
  const ids = new Set<string>();
  for (const m of sprint.members) {
    if (t(m.addedAt) <= t(at) && (m.removedAt === null || t(m.removedAt) > t(at)))
      ids.add(m.issueId);
  }
  return ids;
}

export const indexIssues = (issues: readonly MetricIssue[]) =>
  new Map(issues.map((i) => [i.id, i] as const));
```

`packages/metrics/src/scrum.ts`:
```ts
import { categoryAt, indexIssues, membersAt, valueAt } from './issue';
import type { BoardDataset, MetricIssue, MetricSprint, Unit } from './model';
import { round, sum } from './stats';
import { eachUtcDay, endOfDayCapped, isoDay } from './time';

export interface SprintVelocity {
  sprintId: string;
  name: string;
  /** Worth of the issues in the sprint when it started (estimates as of the start). */
  committed: number;
  /** Worth of the issues done when it closed (estimates as of the close), added scope included. */
  completed: number;
  committedCount: number;
  completedCount: number;
}

export interface ScopeChange {
  sprintId: string;
  name: string;
  committed: number;
  added: number;
  removed: number;
  addedCount: number;
  removedCount: number;
}

export interface CarryOver {
  sprintId: string;
  name: string;
  count: number;
  points: number;
  issueKeys: string[];
}

const ms = (d: Date) => d.getTime();
const justBefore = (d: Date) => new Date(ms(d) - 1);

function pick(ids: Iterable<string>, byId: Map<string, MetricIssue>): MetricIssue[] {
  return [...ids].flatMap((id) => {
    const issue = byId.get(id);
    return issue ? [issue] : [];
  });
}

const closedSprints = (ds: BoardDataset) =>
  ds.sprints
    .filter(
      (s): s is MetricSprint & { startAt: Date; completeAt: Date } =>
        s.state === 'closed' && s.startAt !== null && s.completeAt !== null,
    )
    .sort((a, b) => ms(a.completeAt) - ms(b.completeAt));

/** The active sprint, or the most recently closed one. */
export function currentSprint(ds: BoardDataset): MetricSprint | undefined {
  return ds.sprints.find((s) => s.state === 'active' && s.startAt) ?? closedSprints(ds).at(-1);
}

export const lastClosedSprint = (ds: BoardDataset): MetricSprint | undefined =>
  closedSprints(ds).at(-1);

/**
 * Committed vs completed for the last `sprints` closed sprints (oldest first).
 * Committed = in the sprint at its start. Completed = in the sprint just before it closed and done
 * when it closed (issues Jira moves out at close are still counted as carried over, not completed).
 */
export function velocity(
  ds: BoardDataset,
  opts: { sprints?: number; unit?: Unit } = {},
): SprintVelocity[] {
  const unit = opts.unit ?? 'points';
  const byId = indexIssues(ds.issues);
  return closedSprints(ds)
    .slice(-(opts.sprints ?? 6))
    .map((s) => {
      const committed = pick(membersAt(s, s.startAt), byId);
      const done = pick(membersAt(s, justBefore(s.completeAt)), byId).filter(
        (i) => categoryAt(i, s.completeAt) === 'done',
      );
      return {
        sprintId: s.id,
        name: s.name,
        committed: sum(committed.map((i) => valueAt(i, s.startAt, unit))),
        completed: sum(done.map((i) => valueAt(i, s.completeAt, unit))),
        committedCount: committed.length,
        completedCount: done.length,
      };
    });
}

/** Mean completed per sprint and completed / committed ("say/do") over the given sprints. */
export function velocitySummary(rows: readonly SprintVelocity[]): {
  average: number | null;
  sayDoRatio: number | null;
} {
  if (rows.length === 0) return { average: null, sayDoRatio: null };
  const committed = sum(rows.map((r) => r.committed));
  const completed = sum(rows.map((r) => r.completed));
  return {
    average: round(completed / rows.length, 1),
    sayDoRatio: committed > 0 ? round(completed / committed, 4) : null,
  };
}

/** Scope added/removed after the sprint started (until it closed, or `now` while active). */
export function scopeChange(
  ds: BoardDataset,
  sprint: MetricSprint,
  opts: { unit?: Unit; now: Date },
): ScopeChange | null {
  if (!sprint.startAt) return null;
  const unit = opts.unit ?? 'points';
  const start = sprint.startAt;
  const end = sprint.completeAt ?? opts.now;
  const byId = indexIssues(ds.issues);
  const within = (d: Date) => ms(d) > ms(start) && ms(d) < ms(end);
  const added = new Map<string, number>();
  const removed = new Map<string, number>();
  for (const m of sprint.members) {
    const issue = byId.get(m.issueId);
    if (!issue) continue;
    if (within(m.addedAt) && !added.has(issue.id))
      added.set(issue.id, valueAt(issue, m.addedAt, unit));
    if (m.removedAt && within(m.removedAt) && !removed.has(issue.id)) {
      removed.set(issue.id, valueAt(issue, m.removedAt, unit));
    }
  }
  const committed = pick(membersAt(sprint, start), byId);
  return {
    sprintId: sprint.id,
    name: sprint.name,
    committed: sum(committed.map((i) => valueAt(i, start, unit))),
    added: sum([...added.values()]),
    removed: sum([...removed.values()]),
    addedCount: added.size,
    removedCount: removed.size,
  };
}

/** Issues still in a closed sprint at its close that were not done. */
export function carryOver(ds: BoardDataset, sprint: MetricSprint): CarryOver | null {
  if (sprint.state !== 'closed' || !sprint.completeAt) return null;
  const at = sprint.completeAt;
  const left = pick(membersAt(sprint, justBefore(at)), indexIssues(ds.issues)).filter(
    (i) => categoryAt(i, at) !== 'done',
  );
  return {
    sprintId: sprint.id,
    name: sprint.name,
    count: left.length,
    points: sum(left.map((i) => valueAt(i, at, 'points'))),
    issueKeys: left.map((i) => i.key).sort(),
  };
}

export interface BurnRow {
  day: string;
  /** Not-done work in the sprint at the end of the day; null for days still ahead. */
  remaining: number | null;
  /** Straight line from the committed total at the first day to 0 at the planned end. */
  ideal: number;
  scope: number | null;
  completed: number | null;
}

/**
 * Daily burndown/burnup for one sprint, sampled at the end of each UTC day from the start day to
 * the planned end day (or the close day, if later). Days after `now` (or after close) are null.
 */
export function sprintBurn(
  ds: BoardDataset,
  sprint: MetricSprint,
  opts: { unit?: Unit; now: Date },
): BurnRow[] {
  if (!sprint.startAt) return [];
  const unit = opts.unit ?? 'points';
  const byId = indexIssues(ds.issues);
  const cap = sprint.completeAt ?? opts.now;
  const plannedEnd = sprint.endAt ?? cap;
  const lastDay = new Date(Math.max(ms(plannedEnd), ms(sprint.completeAt ?? plannedEnd)));
  const days = eachUtcDay(sprint.startAt, lastDay);
  const committed = sum(
    pick(membersAt(sprint, sprint.startAt), byId).map((i) =>
      valueAt(i, sprint.startAt as Date, unit),
    ),
  );
  const plannedDays = Math.max(1, eachUtcDay(sprint.startAt, plannedEnd).length - 1);
  return days.map((day, index) => {
    const ideal = round(Math.max(0, committed * (1 - index / plannedDays)), 2);
    if (ms(day) > ms(cap)) {
      return { day: isoDay(day), remaining: null, ideal, scope: null, completed: null };
    }
    const at = endOfDayCapped(day, cap);
    const members = pick(membersAt(sprint, at), byId);
    const done = members.filter((i) => categoryAt(i, at) === 'done');
    const scope = sum(members.map((i) => valueAt(i, at, unit)));
    const completed = sum(done.map((i) => valueAt(i, at, unit)));
    return { day: isoDay(day), remaining: round(scope - completed, 2), ideal, scope, completed };
  });
}
```

`packages/metrics/src/index.ts` (Task 3 extends it):
```ts
export { categoryAt, currentCategory, cycleStart, doneAt, estimateAt } from './issue';
export type {
  BoardDataset,
  EstimateChange,
  Interval,
  MetricIssue,
  MetricSprint,
  SprintMember,
  StatusCategory,
  StatusPeriod,
  Unit,
} from './model';
export {
  type BurnRow,
  type CarryOver,
  carryOver,
  currentSprint,
  lastClosedSprint,
  type ScopeChange,
  type SprintVelocity,
  scopeChange,
  sprintBurn,
  velocity,
  velocitySummary,
} from './scrum';
export { percentile } from './stats';
export { addDays, DAY, isoDay, startOfUtcDay } from './time';
```

- [ ] **Step 5: Run tests, lint, typecheck**

Run: `pnpm vitest run --project metrics && pnpm lint && pnpm typecheck`
Expected: PASS — 6 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(metrics): dataset model and Scrum metrics with golden tests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `@agile/metrics` — flow metrics, hygiene checks and Monte Carlo forecasts

**Files:**
- Create: `packages/metrics/src/{flow,hygiene,forecast}.ts`
- Modify: `packages/metrics/src/index.ts`
- Test: `packages/metrics/src/{flow,hygiene,forecast}.test.ts`

**Interfaces:**
- Flow: `completedItems(ds, { windowDays?: 90, now })`, `cycleTime(ds, opts)` / `leadTime(ds, opts)`: `PercentileSummary { count; p50; p85; p95 }` (days), `weeklyThroughput(ds, { weeks?: 12, now })`, `throughputPerWeek(ds, { days?: 28, now }): number`, `wipNow(ds)`, `wipSeries(ds, { days?: 30, now })`, `cumulativeFlow(ds, { days?: 30, now })` (`{ day; todo; inProgress; done }`), `agingWip(ds, { windowDays?, now }): AgingItem[]`, `flowEfficiency(ds, { windowDays?, now }): { efficiency: number | null; cycleDays; blockedDays }`.
- Hygiene: `hygiene(ds, { now, staleDays?: 14, oversizedPoints?: 13 }): HygieneFinding[]` with `problems: ('stale' | 'missing_estimate' | 'unassigned_in_progress' | 'oversized')[]`.
- Forecast: `dailyThroughputSamples(ds, { historyDays?: 30, now }): number[]`, `forecastHowMany(samples, { days, trials?: 10000, seed?: 42 })`, `forecastWhen(samples, { items, trials?, seed?, maxDays?: 730 })` → `Forecast { p50; p85; p95 } | null`.

**Definitions:**
- *Cycle time* = first entry into an in-progress status → start of the final done period; issues that never were in progress have no cycle time but do have a *lead time* (created → done). Window = done in `(now − windowDays, now]`.
- *Percentiles* use the nearest-rank method (an observed value; checkable by hand).
- *Throughput per week* is rolling (`done in the trailing N days × 7 / N`), not calendar weeks, so a KPI does not jump on Mondays; the bar chart uses ISO weeks (Monday, UTC).
- *WIP* = issues whose mapped category is in progress (waiting states included).
- **Ruling — flow efficiency / blocked time.** Wait time = time inside the cycle (cycle start → done) spent in a status mapped as *waiting* (`blocked`) **or** flagged as an impediment (Jira's "Flagged" field, from the changelog), as a union of intervals. Efficiency = (Σ cycle − Σ wait) / Σ cycle over the window. Cost if wrong: teams that neither flag nor map waiting statuses read ~100% (the UI tells them to mark waiting statuses).
- *Hygiene* (open issues only): stale = not updated for `staleDays`; missing estimate only on boards with an estimation field; unassigned while in progress; oversized = estimate > `oversizedPoints`.
- *Monte Carlo*: daily throughput samples from the last `historyDays` full UTC days (today excluded). "How many in N days": pXX is the count reached in at least XX% of trials (so p95 ≤ p85 ≤ p50). "When will N be done": pXX is the number of days within which XX% of trials finished (p50 ≤ p85 ≤ p95); no forecast without finished items. Seeded `xoroshiro128plus` (pure-rand) → identical results for identical data.

- [ ] **Step 1: Write the failing tests**

`packages/metrics/src/flow.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { d, flowFixture } from './fixtures';
import {
  agingWip,
  completedItems,
  cumulativeFlow,
  cycleTime,
  flowEfficiency,
  leadTime,
  throughputPerWeek,
  weeklyThroughput,
  wipNow,
  wipSeries,
} from './flow';

describe('flow metrics (golden: flowFixture, now = d30)', () => {
  const ds = flowFixture();
  const now = d(30);

  it('completed items with cycle, lead and blocked days', () => {
    expect(
      completedItems(ds, { now }).map((c) => [c.key, c.cycleDays, c.leadDays, c.blockedDays]),
    ).toEqual([
      ['K1', 2, 4, 0],
      ['K2', 8, 10, 3], // Blocked d5→d7 plus flagged d8→d9
      ['K3', null, 4, 0], // never in progress
      ['K4', 20, 21, 0],
    ]);
  });

  it('cycle time percentiles (nearest rank over [2, 8, 20])', () => {
    expect(cycleTime(ds, { now })).toEqual({ count: 3, p50: 8, p85: 20, p95: 20 });
  });

  it('lead time percentiles (nearest rank over [4, 4, 10, 21])', () => {
    expect(leadTime(ds, { now })).toEqual({ count: 4, p50: 4, p85: 21, p95: 21 });
  });

  it('respects the window', () => {
    // (d30 - 10 days, d30] keeps only K4 (done d26)
    expect(cycleTime(ds, { now, windowDays: 10 })).toEqual({ count: 1, p50: 20, p85: 20, p95: 20 });
  });

  it('weekly throughput by ISO week', () => {
    // K1 d4, K3 d6 → week of d0; K2 d11 → d7; K4 d26 → d21; d28 week is current
    expect(weeklyThroughput(ds, { now, weeks: 5 })).toEqual([
      { weekStart: '2026-01-05', count: 2 },
      { weekStart: '2026-01-12', count: 1 },
      { weekStart: '2026-01-19', count: 0 },
      { weekStart: '2026-01-26', count: 1 },
      { weekStart: '2026-02-02', count: 0 },
    ]);
  });

  it('rolling throughput per week', () => {
    // (d2, d30]: K1, K3, K2, K4 = 4 items over 4 weeks
    expect(throughputPerWeek(ds, { now })).toBe(1);
    // (d23, d30]: K4 only
    expect(throughputPerWeek(ds, { now, days: 7 })).toBe(1);
  });

  it('work in progress now and over time', () => {
    expect(wipNow(ds)).toBe(2);
    expect(wipSeries(ds, { now, days: 5 })).toEqual([
      { day: '2026-01-31', wip: 1 },
      { day: '2026-02-01', wip: 1 },
      { day: '2026-02-02', wip: 2 },
      { day: '2026-02-03', wip: 2 },
      { day: '2026-02-04', wip: 2 },
    ]);
  });

  it('cumulative flow', () => {
    expect(cumulativeFlow(ds, { now, days: 3 })).toEqual([
      { day: '2026-02-02', todo: 0, inProgress: 2, done: 4 },
      { day: '2026-02-03', todo: 1, inProgress: 2, done: 4 }, // K7 created d29
      { day: '2026-02-04', todo: 1, inProgress: 2, done: 4 },
    ]);
  });

  it('aging work in progress, oldest first, against the p85 cycle time (20 d)', () => {
    expect(agingWip(ds, { now }).map((a) => [a.key, a.ageDays, a.blocked, a.overP85])).toEqual([
      ['K5', 10, false, false],
      ['K6', 2, false, false],
    ]);
    // With a 10-day window the p85 is 20 too; with a 5-day window nothing finished → no reference.
    expect(agingWip(ds, { now, windowDays: 5 }).every((a) => !a.overP85)).toBe(true);
  });

  it('flow efficiency: (30 cycle days − 3 blocked) / 30', () => {
    expect(flowEfficiency(ds, { now })).toEqual({ efficiency: 0.9, cycleDays: 30, blockedDays: 3 });
    expect(flowEfficiency(ds, { now, windowDays: 1 })).toEqual({
      efficiency: null,
      cycleDays: 0,
      blockedDays: 0,
    });
  });
});
```

`packages/metrics/src/hygiene.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { d, flowFixture } from './fixtures';
import { hygiene } from './hygiene';

describe('hygiene (golden: flowFixture, now = d30)', () => {
  it('flags stale, unestimated, unassigned in-progress and oversized open issues', () => {
    const findings = hygiene(flowFixture(), { now: d(30) });
    expect(findings.map((f) => [f.key, f.problems])).toEqual([
      ['K5', ['stale', 'oversized']], // updated d10 (20 days ago), 21 pts > 13
      ['K6', ['unassigned_in_progress']],
      ['K7', ['missing_estimate']],
    ]);
  });

  it('does not ask for estimates on boards that do not estimate', () => {
    const findings = hygiene({ ...flowFixture(), hasEstimates: false }, { now: d(30) });
    expect(findings.map((f) => f.key)).toEqual(['K5', 'K6']);
  });

  it('honours custom thresholds', () => {
    const findings = hygiene(flowFixture(), { now: d(30), staleDays: 30, oversizedPoints: 50 });
    expect(findings.map((f) => [f.key, f.problems])).toEqual([
      ['K6', ['unassigned_in_progress']],
      ['K7', ['missing_estimate']],
    ]);
  });
});
```

`packages/metrics/src/forecast.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { d, flowFixture } from './fixtures';
import { dailyThroughputSamples, forecastHowMany, forecastWhen } from './forecast';

describe('Monte Carlo forecasting', () => {
  it('collects daily throughput for the last full days', () => {
    // d20..d29; only K4 finished in that range (d26)
    expect(dailyThroughputSamples(flowFixture(), { now: d(30, 15), historyDays: 10 })).toEqual([
      0, 0, 0, 0, 0, 0, 1, 0, 0, 0,
    ]);
  });

  it('is exact when throughput never varies', () => {
    expect(forecastHowMany([2, 2, 2], { days: 10 })).toEqual({ p50: 20, p85: 20, p95: 20 });
    expect(forecastWhen([2, 2, 2], { items: 7 })).toEqual({ p50: 4, p85: 4, p95: 4 });
  });

  it('is deterministic for a seed and ordered by confidence', () => {
    const samples = [0, 1, 0, 3, 2, 0, 1, 4, 0, 2];
    const a = forecastHowMany(samples, { days: 14, seed: 7 });
    expect(forecastHowMany(samples, { days: 14, seed: 7 })).toEqual(a);
    expect(a && a.p95 <= a.p85 && a.p85 <= a.p50).toBe(true);
    const w = forecastWhen(samples, { items: 20, seed: 7 });
    expect(forecastWhen(samples, { items: 20, seed: 7 })).toEqual(w);
    expect(w && w.p50 <= w.p85 && w.p85 <= w.p95).toBe(true);
    // Mean throughput is 1.3/day, so 20 items take about 15 days at the median.
    expect(w?.p50).toBeGreaterThanOrEqual(12);
    expect(w?.p50).toBeLessThanOrEqual(19);
  });

  it('refuses to forecast without history', () => {
    expect(forecastHowMany([], { days: 5 })).toBeNull();
    expect(forecastWhen([0, 0, 0], { items: 3 })).toBeNull();
  });

  it('caps runaway trials at maxDays', () => {
    expect(
      forecastWhen([1, 0, 0, 0, 0, 0, 0, 0, 0, 0], { items: 50, maxDays: 30, trials: 200 })?.p95,
    ).toBe(30);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project metrics`
Expected: FAIL — `Cannot find module './flow'`, `'./hygiene'`, `'./forecast'`.

- [ ] **Step 3: Implement**

`packages/metrics/src/flow.ts`:
```ts
import { blockedStatusIntervals, categoryAt, currentCategory, cycleStart, doneAt } from './issue';
import type { BoardDataset, MetricIssue } from './model';
import { coveredMs, percentile, round, sum } from './stats';
import { addDays, DAY, eachUtcDay, endOfDayCapped, isoDay, startOfUtcWeek, toDays } from './time';

export interface CompletedItem {
  issueId: string;
  key: string;
  doneAt: Date;
  /** null when the issue never entered an in-progress status (went straight to done). */
  cycleDays: number | null;
  leadDays: number;
  /** Time in a blocked status or flagged, between cycle start and done. */
  blockedDays: number;
}

export interface PercentileSummary {
  count: number;
  p50: number | null;
  p85: number | null;
  p95: number | null;
}

const ms = (d: Date) => d.getTime();

/** Issues whose final transition to done happened in (now - windowDays, now]. */
export function completedItems(
  ds: BoardDataset,
  opts: { windowDays?: number; now: Date },
): CompletedItem[] {
  const from = ms(opts.now) - (opts.windowDays ?? 90) * DAY;
  return ds.issues.flatMap((issue) => {
    const end = doneAt(issue);
    if (!end || ms(end) <= from || ms(end) > ms(opts.now)) return [];
    const start = cycleStart(issue);
    const usable = start && ms(start) < ms(end) ? start : null;
    const blocked = usable
      ? coveredMs([...blockedStatusIntervals(issue), ...issue.flagged], usable, end)
      : 0;
    return [
      {
        issueId: issue.id,
        key: issue.key,
        doneAt: end,
        cycleDays: usable ? round(toDays(ms(end) - ms(usable)), 2) : null,
        leadDays: round(toDays(ms(end) - ms(issue.createdAt)), 2),
        blockedDays: round(toDays(blocked), 2),
      },
    ];
  });
}

const summarize = (values: number[]): PercentileSummary => ({
  count: values.length,
  p50: percentile(values, 50),
  p85: percentile(values, 85),
  p95: percentile(values, 95),
});

/** Cycle time (first in-progress → done) percentiles, in days. */
export const cycleTime = (ds: BoardDataset, opts: { windowDays?: number; now: Date }) =>
  summarize(completedItems(ds, opts).flatMap((c) => (c.cycleDays === null ? [] : [c.cycleDays])));

/** Lead time (created → done) percentiles, in days. */
export const leadTime = (ds: BoardDataset, opts: { windowDays?: number; now: Date }) =>
  summarize(completedItems(ds, opts).map((c) => c.leadDays));

/** Items finished per ISO week (Monday, UTC), oldest first, ending with the current week. */
export function weeklyThroughput(
  ds: BoardDataset,
  opts: { weeks?: number; now: Date },
): { weekStart: string; count: number }[] {
  const weeks = opts.weeks ?? 12;
  const current = startOfUtcWeek(opts.now);
  const starts = Array.from({ length: weeks }, (_, i) => addDays(current, -7 * (weeks - 1 - i)));
  const counts = new Map(starts.map((s) => [isoDay(s), 0]));
  for (const issue of ds.issues) {
    const end = doneAt(issue);
    if (!end || ms(end) > ms(opts.now)) continue;
    const key = isoDay(startOfUtcWeek(end));
    const n = counts.get(key);
    if (n !== undefined) counts.set(key, n + 1);
  }
  return starts.map((s) => ({ weekStart: isoDay(s), count: counts.get(isoDay(s)) ?? 0 }));
}

/** Average items finished per 7 days over the trailing window (rolling, not calendar weeks). */
export function throughputPerWeek(ds: BoardDataset, opts: { days?: number; now: Date }): number {
  const days = opts.days ?? 28;
  const from = ms(opts.now) - days * DAY;
  const done = ds.issues.filter((i) => {
    const end = doneAt(i);
    return end !== null && ms(end) > from && ms(end) <= ms(opts.now);
  }).length;
  return round((done * 7) / days, 1);
}

/** Issues in progress now. */
export const wipNow = (ds: BoardDataset): number =>
  ds.issues.filter((i) => currentCategory(i) === 'in_progress').length;

/** Issues in progress at the end of each of the last `days` UTC days (today capped at now). */
export function wipSeries(
  ds: BoardDataset,
  opts: { days?: number; now: Date },
): { day: string; wip: number }[] {
  return lastDays(opts.days ?? 30, opts.now).map((day) => {
    const at = endOfDayCapped(day, opts.now);
    return {
      day: isoDay(day),
      wip: ds.issues.filter((i) => categoryAt(i, at) === 'in_progress').length,
    };
  });
}

/** Cumulative flow: issues per category at the end of each of the last `days` UTC days. */
export function cumulativeFlow(
  ds: BoardDataset,
  opts: { days?: number; now: Date },
): { day: string; todo: number; inProgress: number; done: number }[] {
  return lastDays(opts.days ?? 30, opts.now).map((day) => {
    const at = endOfDayCapped(day, opts.now);
    const row = { day: isoDay(day), todo: 0, inProgress: 0, done: 0 };
    for (const issue of ds.issues) {
      const c = categoryAt(issue, at);
      if (c === 'todo') row.todo++;
      else if (c === 'in_progress') row.inProgress++;
      else if (c === 'done') row.done++;
    }
    return row;
  });
}

export interface AgingItem {
  issueId: string;
  key: string;
  summary: string;
  ageDays: number;
  blocked: boolean;
  /** Older than the 85th percentile cycle time: likely to finish late. */
  overP85: boolean;
}

/** In-progress items with their age since they started, oldest first. */
export function agingWip(ds: BoardDataset, opts: { windowDays?: number; now: Date }): AgingItem[] {
  const p85 = cycleTime(ds, opts).p85;
  return ds.issues
    .filter((i) => currentCategory(i) === 'in_progress')
    .map((i) => {
      const start = cycleStart(i) ?? i.createdAt;
      const ageDays = round(toDays(ms(opts.now) - ms(start)), 1);
      return {
        issueId: i.id,
        key: i.key,
        summary: i.summary,
        ageDays,
        blocked: (i.statusPeriods.at(-1)?.blocked ?? false) || isFlagged(i, opts.now),
        overP85: p85 !== null && ageDays > p85,
      };
    })
    .sort((a, b) => b.ageDays - a.ageDays || a.key.localeCompare(b.key));
}

/**
 * Flow efficiency of items finished in the window: share of their cycle time not spent blocked
 * (in a status mapped as blocked, or flagged). null when nothing was finished.
 */
export function flowEfficiency(
  ds: BoardDataset,
  opts: { windowDays?: number; now: Date },
): { efficiency: number | null; cycleDays: number; blockedDays: number } {
  const items = completedItems(ds, opts).filter((c) => c.cycleDays !== null);
  const cycleDays = round(sum(items.map((c) => c.cycleDays ?? 0)), 2);
  const blockedDays = round(sum(items.map((c) => c.blockedDays)), 2);
  return {
    efficiency: cycleDays > 0 ? round((cycleDays - blockedDays) / cycleDays, 4) : null,
    cycleDays,
    blockedDays,
  };
}

function isFlagged(issue: MetricIssue, at: Date): boolean {
  return issue.flagged.some((f) => ms(f.from) <= ms(at) && (f.to === null || ms(f.to) > ms(at)));
}

function lastDays(days: number, now: Date): Date[] {
  return eachUtcDay(addDays(now, -(days - 1)), now);
}
```

`packages/metrics/src/hygiene.ts`:
```ts
import { currentCategory } from './issue';
import type { BoardDataset } from './model';
import { DAY } from './time';

export type HygieneProblem = 'stale' | 'missing_estimate' | 'unassigned_in_progress' | 'oversized';

export interface HygieneFinding {
  issueId: string;
  key: string;
  summary: string;
  problems: HygieneProblem[];
}

/**
 * Open issues needing attention: not updated for `staleDays`; unestimated on a board that uses
 * estimates; in progress without an assignee; estimated above `oversizedPoints`.
 */
export function hygiene(
  ds: BoardDataset,
  opts: { now: Date; staleDays?: number; oversizedPoints?: number },
): HygieneFinding[] {
  const staleBefore = opts.now.getTime() - (opts.staleDays ?? 14) * DAY;
  const oversized = opts.oversizedPoints ?? 13;
  return ds.issues
    .filter((i) => currentCategory(i) !== 'done')
    .map((i) => {
      const problems: HygieneProblem[] = [];
      if (i.updatedAt.getTime() < staleBefore) problems.push('stale');
      if (ds.hasEstimates && i.estimate === null) problems.push('missing_estimate');
      if (currentCategory(i) === 'in_progress' && i.assignee === null) {
        problems.push('unassigned_in_progress');
      }
      if (i.estimate !== null && i.estimate > oversized) problems.push('oversized');
      return { issueId: i.id, key: i.key, summary: i.summary, problems };
    })
    .filter((f) => f.problems.length > 0)
    .sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }));
}
```

`packages/metrics/src/forecast.ts`:
```ts
import { uniformInt } from 'pure-rand/distribution/uniformInt';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import { doneAt } from './issue';
import type { BoardDataset } from './model';
import { addDays, isoDay, startOfUtcDay } from './time';

export interface Forecast {
  p50: number;
  p85: number;
  p95: number;
}

/** Items finished on each of the last `historyDays` full UTC days (today excluded). */
export function dailyThroughputSamples(
  ds: BoardDataset,
  opts: { historyDays?: number; now: Date },
): number[] {
  const days = opts.historyDays ?? 30;
  const today = startOfUtcDay(opts.now);
  const keys = Array.from({ length: days }, (_, i) => isoDay(addDays(today, i - days)));
  const counts = new Map(keys.map((k) => [k, 0]));
  for (const issue of ds.issues) {
    const end = doneAt(issue);
    if (!end) continue;
    const k = isoDay(end);
    const n = counts.get(k);
    if (n !== undefined) counts.set(k, n + 1);
  }
  return keys.map((k) => counts.get(k) ?? 0);
}

/**
 * "How many items will be finished in the next `days` days?" Each trial sums `days` throughput
 * values drawn (with replacement) from past days. pXX is the count reached in at least XX% of
 * trials, so p95 <= p85 <= p50. null when there is no history.
 */
export function forecastHowMany(
  samples: readonly number[],
  opts: { days: number; trials?: number; seed?: number },
): Forecast | null {
  if (samples.length === 0 || opts.days < 1) return null;
  const trials = opts.trials ?? 10_000;
  const rng = xoroshiro128plus(opts.seed ?? 42);
  const totals: number[] = [];
  for (let trial = 0; trial < trials; trial++) {
    let total = 0;
    for (let d = 0; d < opts.days; d++)
      total += samples[uniformInt(rng, 0, samples.length - 1)] ?? 0;
    totals.push(total);
  }
  totals.sort((a, b) => a - b);
  const atLeast = (p: number) => totals[Math.floor((1 - p / 100) * trials)] ?? 0;
  return { p50: atLeast(50), p85: atLeast(85), p95: atLeast(95) };
}

/**
 * "In how many days will `items` items be finished?" pXX is the number of days within which XX%
 * of trials finished, so p50 <= p85 <= p95. Trials are capped at `maxDays`. null when the history
 * has no finished items (no forecast is possible).
 */
export function forecastWhen(
  samples: readonly number[],
  opts: { items: number; trials?: number; seed?: number; maxDays?: number },
): Forecast | null {
  if (samples.length === 0 || samples.every((s) => s === 0) || opts.items < 1) return null;
  const trials = opts.trials ?? 10_000;
  const maxDays = opts.maxDays ?? 730;
  const rng = xoroshiro128plus(opts.seed ?? 42);
  const durations: number[] = [];
  for (let trial = 0; trial < trials; trial++) {
    let total = 0;
    let days = 0;
    while (total < opts.items && days < maxDays) {
      total += samples[uniformInt(rng, 0, samples.length - 1)] ?? 0;
      days++;
    }
    durations.push(days);
  }
  durations.sort((a, b) => a - b);
  const within = (p: number) =>
    durations[Math.min(trials, Math.max(1, Math.ceil((p / 100) * trials))) - 1] ?? maxDays;
  return { p50: within(50), p85: within(85), p95: within(95) };
}
```

`packages/metrics/src/index.ts`:
```ts
export {
  type AgingItem,
  agingWip,
  type CompletedItem,
  completedItems,
  cumulativeFlow,
  cycleTime,
  flowEfficiency,
  leadTime,
  type PercentileSummary,
  throughputPerWeek,
  weeklyThroughput,
  wipNow,
  wipSeries,
} from './flow';
export {
  dailyThroughputSamples,
  type Forecast,
  forecastHowMany,
  forecastWhen,
} from './forecast';
export { type HygieneFinding, type HygieneProblem, hygiene } from './hygiene';
export { categoryAt, currentCategory, cycleStart, doneAt, estimateAt } from './issue';
export type {
  BoardDataset,
  EstimateChange,
  Interval,
  MetricIssue,
  MetricSprint,
  SprintMember,
  StatusCategory,
  StatusPeriod,
  Unit,
} from './model';
export {
  type BurnRow,
  type CarryOver,
  carryOver,
  currentSprint,
  lastClosedSprint,
  type ScopeChange,
  type SprintVelocity,
  scopeChange,
  sprintBurn,
  velocity,
  velocitySummary,
} from './scrum';
export { percentile } from './stats';
export { addDays, DAY, isoDay, startOfUtcDay } from './time';
```

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `pnpm vitest run --project metrics && pnpm lint && pnpm typecheck`
Expected: PASS — 24 tests (6 scrum, 10 flow, 3 hygiene, 5 forecast).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(metrics): flow metrics, hygiene checks and seeded Monte Carlo forecasts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `@agile/jira` — changelog normalisation, lenient response schemas, status suggestions, JQL window

**Files:**
- Create: `packages/jira/src/sync-types.ts`, `packages/jira/src/issue-normalize.ts`, `packages/jira/src/responses.ts`
- Modify: `packages/jira/src/index.ts`
- Test: `packages/jira/src/issue-normalize.test.ts`

**Interfaces:**
- Types: `JiraBoardInfo`, `JiraBoardConfig { filterId; estimationFieldId; estimationFieldName; columns }`, `JiraStatusInfo { id; name; categoryKey }`, `JiraFieldInfo { id; name; custom }`, `JiraSprintInfo`, `RawChangelogItem { field; fieldId; from; fromText; to; toText }` (all `string | null`), `RawChangelogHistory { id?; created; items }`, `RawIssue { id; key; fields; changelog? }`, `NormalizedIssue { …issue fields; transitions; changes; sprintMembership }`, `IssueFieldContext { estimationFieldId; estimationFieldName; sprintFieldId }`.
- Functions: `normalizeIssue(raw, histories, ctx): NormalizedIssue`, `parseJiraDate(value): Date | null` (accepts Jira's `+0200` offsets), `parseSprintField(value): number[]` (Cloud objects and legacy Data Center `…Sprint@x[id=12,…]` strings), `deriveSprintMembership(createdAt, currentIds, changes)`, `findSprintField(fields)`, `issueFieldList(ctx): string[]`, `suggestStatusMapping(status): { category; blocked }`, `buildIssueJql(filterId, since, now): string`, `SYNC_OVERLAP_MINUTES = 15`.
- Lenient schemas (responses.ts): `historySchema`, `rawIssueSchema`, `boardPageSchema` + `toBoardInfo`, `boardConfigSchema`, `sprintPageSchema`, `statusListSchema`, `fieldListSchema`, `cloudSearchSchema`, `dcSearchSchema`, `changelogPageSchema`, `issueChangelogSchema`, `isLastPage(page, received, count)`.

**Normalisation rules:**
- Histories are sorted oldest first (some endpoints return newest first); one `seq` counter numbers status transitions and estimate/flag changes in changelog order.
- Status transitions: items with `field`/`fieldId` = `status`; `from`/`to` are status ids.
- Estimates: items whose `fieldId` is the board's estimation field or whose `field` is its display name (Data Center items have no `fieldId`); values are the displayed numbers (`fromText`/`toText`, falling back to `from`/`to`).
- Flags: `field = 'Flagged'`; any non-empty value is `on`.
- **Sprint membership** comes from the Sprint field's history: the set before the first change is that change's `from` (the issue was *created* in those sprints), otherwise the current field value; each change replaces the set with its `to`. Jira keeps closed sprints in the field when an issue is carried over (`1` → `1, 2`), so a carried-over issue stays a member of the sprint it left.
- **JQL window** (Review Focus 2): `filter = <id> ORDER BY created ASC` for a full read, else `filter = <id> AND updated >= "-<minutes since watermark + 15>m" ORDER BY created ASC`. Relative dates are time-zone proof; absolute JQL dates are read in the Jira user's zone. Ordering by `created` keeps offset pagination stable while issues are being updated.
- Status suggestions: Jira category `new` → to do, `done` → done, anything else → in progress; an in-progress status whose name matches `block|imped|on hold|waiting` is suggested as *waiting*.

- [ ] **Step 1: Write the failing tests**

`packages/jira/src/issue-normalize.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  buildIssueJql,
  deriveSprintMembership,
  issueFieldList,
  normalizeIssue,
  parseJiraDate,
  parseSprintField,
  suggestStatusMapping,
} from './issue-normalize';
import { historySchema } from './responses';
import type { IssueFieldContext, RawIssue } from './sync-types';

const ctx: IssueFieldContext = {
  estimationFieldId: 'customfield_10016',
  estimationFieldName: 'Story Points',
  sprintFieldId: 'customfield_10020',
};
const history = (id: string, created: string, items: Record<string, unknown>[]) =>
  historySchema.parse({ id, created, items });

const raw: RawIssue = {
  id: '10001',
  key: 'DEMO-1',
  fields: {
    summary: 'Checkout flow',
    issuetype: { name: 'Story', subtask: false },
    status: { id: '10003', name: 'Done' },
    assignee: { accountId: 'u-1', displayName: 'Alex' },
    created: '2026-01-01T09:00:00.000+0100',
    updated: '2026-01-09T10:00:00.000+0000',
    resolutiondate: '2026-01-09T10:00:00.000+0000',
    customfield_10016: 5,
    customfield_10020: [
      { id: 1, name: 'Sprint 1' },
      { id: 2, name: 'Sprint 2' },
    ],
  },
};

describe('parseJiraDate', () => {
  it('reads Jira offsets without a colon', () => {
    expect(parseJiraDate('2026-01-01T09:00:00.000+0100')?.toISOString()).toBe(
      '2026-01-01T08:00:00.000Z',
    );
    expect(parseJiraDate('2026-01-01T09:00:00.000Z')?.toISOString()).toBe(
      '2026-01-01T09:00:00.000Z',
    );
    expect(parseJiraDate('garbage')).toBeNull();
    expect(parseJiraDate(null)).toBeNull();
  });
});

describe('parseSprintField', () => {
  it('reads Cloud objects and legacy Data Center strings', () => {
    expect(parseSprintField([{ id: 3 }, { id: 4 }])).toEqual([3, 4]);
    expect(
      parseSprintField([
        'com.atlassian.greenhopper.service.sprint.Sprint@1a2b[id=12,rapidViewId=3,state=CLOSED,name=S12]',
      ]),
    ).toEqual([12]);
    expect(parseSprintField(null)).toEqual([]);
  });
});

describe('deriveSprintMembership', () => {
  const t = (iso: string) => new Date(iso);
  it('keeps closed sprints when an issue is carried over', () => {
    expect(
      deriveSprintMembership(
        t('2026-01-01T00:00:00Z'),
        [1, 2],
        [
          { at: t('2026-01-02T00:00:00Z'), from: [], to: [1] },
          { at: t('2026-01-15T00:00:00Z'), from: [1], to: [1, 2] },
        ],
      ),
    ).toEqual([
      { jiraSprintId: 1, addedAt: t('2026-01-02T00:00:00Z'), removedAt: null },
      { jiraSprintId: 2, addedAt: t('2026-01-15T00:00:00Z'), removedAt: null },
    ]);
  });

  it('records removals and issues created inside a sprint', () => {
    expect(
      deriveSprintMembership(
        t('2026-01-01T00:00:00Z'),
        [],
        [{ at: t('2026-01-05T00:00:00Z'), from: [7], to: [] }],
      ),
    ).toEqual([
      { jiraSprintId: 7, addedAt: t('2026-01-01T00:00:00Z'), removedAt: t('2026-01-05T00:00:00Z') },
    ]);
    expect(deriveSprintMembership(t('2026-01-01T00:00:00Z'), [9], [])).toEqual([
      { jiraSprintId: 9, addedAt: t('2026-01-01T00:00:00Z'), removedAt: null },
    ]);
  });
});

describe('normalizeIssue', () => {
  it('extracts transitions, estimate and flag changes, and sprint membership in time order', () => {
    // Histories deliberately newest-first, as some Jira endpoints return them.
    const histories = [
      history('103', '2026-01-09T10:00:00.000+0000', [
        {
          field: 'status',
          fieldId: 'status',
          from: '3',
          fromString: 'In Progress',
          to: '10003',
          toString: 'Done',
        },
      ]),
      history('102', '2026-01-04T10:00:00.000+0000', [
        {
          field: 'Story Points',
          fieldId: 'customfield_10016',
          from: null,
          fromString: '3',
          to: null,
          toString: '5',
        },
        { field: 'Flagged', from: null, fromString: null, to: '[10019]', toString: 'Impediment' },
        {
          field: 'Sprint',
          fieldId: 'customfield_10020',
          from: '1',
          fromString: 'Sprint 1',
          to: '1, 2',
          toString: 'Sprint 1, Sprint 2',
        },
      ]),
      history('101', '2026-01-02T10:00:00.000+0000', [
        { field: 'Sprint', from: null, to: '1' },
        { field: 'status', from: '10000', to: '3' }, // no fromString/toString keys at all
        { field: 'Flagged', from: '[10019]', fromString: 'Impediment', to: null }, // unflag
      ]),
    ];
    const n = normalizeIssue(raw, histories, ctx);
    expect(n).toMatchObject({
      jiraIssueId: '10001',
      key: 'DEMO-1',
      summary: 'Checkout flow',
      issueType: 'Story',
      isSubtask: false,
      statusId: '10003',
      assigneeId: 'u-1',
      assigneeName: 'Alex',
      estimate: 5,
      createdAt: new Date('2026-01-01T08:00:00.000Z'),
      resolvedAt: new Date('2026-01-09T10:00:00.000Z'),
    });
    expect(n.transitions).toEqual([
      { seq: 0, at: new Date('2026-01-02T10:00:00Z'), fromStatusId: '10000', toStatusId: '3' },
      { seq: 4, at: new Date('2026-01-09T10:00:00Z'), fromStatusId: '3', toStatusId: '10003' },
    ]);
    expect(n.changes).toEqual([
      {
        seq: 1,
        at: new Date('2026-01-02T10:00:00Z'),
        kind: 'flag',
        fromValue: 'on',
        toValue: 'off',
      },
      {
        seq: 2,
        at: new Date('2026-01-04T10:00:00Z'),
        kind: 'estimate',
        fromValue: '3',
        toValue: '5',
      },
      {
        seq: 3,
        at: new Date('2026-01-04T10:00:00Z'),
        kind: 'flag',
        fromValue: 'off',
        toValue: 'on',
      },
    ]);
    expect(n.sprintMembership).toEqual([
      { jiraSprintId: 1, addedAt: new Date('2026-01-02T10:00:00Z'), removedAt: null },
      { jiraSprintId: 2, addedAt: new Date('2026-01-04T10:00:00Z'), removedAt: null },
    ]);
  });

  it('copes with a Data Center user and missing optional fields', () => {
    const n = normalizeIssue(
      {
        ...raw,
        fields: {
          status: { id: '1' },
          assignee: { key: 'JIRAUSER9', name: 'kim', displayName: 'Kim' },
          created: '2026-01-01T00:00:00.000+0000',
          updated: '2026-01-01T00:00:00.000+0000',
        },
      },
      [],
      { estimationFieldId: null, estimationFieldName: null, sprintFieldId: null },
    );
    expect(n).toMatchObject({
      summary: '',
      issueType: 'Issue',
      assigneeId: 'JIRAUSER9',
      estimate: null,
      resolvedAt: null,
      sprintMembership: [],
    });
  });

  it('requests exactly the fields it reads', () => {
    expect(issueFieldList(ctx)).toEqual([
      'summary',
      'issuetype',
      'status',
      'assignee',
      'created',
      'updated',
      'resolutiondate',
      'customfield_10016',
      'customfield_10020',
    ]);
  });
});

describe('suggestStatusMapping', () => {
  it('follows Jira status categories and spots waiting states', () => {
    expect(suggestStatusMapping({ id: '1', name: 'Backlog', categoryKey: 'new' })).toEqual({
      category: 'todo',
      blocked: false,
    });
    expect(
      suggestStatusMapping({ id: '2', name: 'In Review', categoryKey: 'indeterminate' }),
    ).toEqual({
      category: 'in_progress',
      blocked: false,
    });
    expect(
      suggestStatusMapping({ id: '3', name: 'Blocked', categoryKey: 'indeterminate' }),
    ).toEqual({
      category: 'in_progress',
      blocked: true,
    });
    expect(
      suggestStatusMapping({ id: '4', name: 'Waiting for customer', categoryKey: 'indeterminate' }),
    ).toMatchObject({ blocked: true });
    expect(suggestStatusMapping({ id: '5', name: 'Closed', categoryKey: 'done' })).toEqual({
      category: 'done',
      blocked: false,
    });
    expect(suggestStatusMapping({ id: '6', name: 'Odd', categoryKey: 'undefined' })).toMatchObject({
      category: 'in_progress',
    });
  });
});

describe('buildIssueJql', () => {
  const now = new Date('2026-10-04T12:00:00Z');
  it('reads the whole board on a first sync', () => {
    expect(buildIssueJql(101, null, now)).toBe('filter = 101 ORDER BY created ASC');
  });
  it('uses relative minutes (time-zone proof) plus a 15-minute overlap', () => {
    expect(buildIssueJql(101, new Date('2026-10-04T11:00:00Z'), now)).toBe(
      'filter = 101 AND updated >= "-75m" ORDER BY created ASC',
    );
    // 59.5 minutes rounds up so nothing slips between syncs
    expect(buildIssueJql(7, new Date('2026-10-04T11:00:30Z'), now)).toBe(
      'filter = 7 AND updated >= "-75m" ORDER BY created ASC',
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project jira src/issue-normalize.test.ts`
Expected: FAIL — `Cannot find module './issue-normalize'`.

- [ ] **Step 3: Implement**

`packages/jira/src/sync-types.ts`:
```ts
export type JiraBoardType = 'scrum' | 'kanban' | 'simple';
export type JiraStatusCategoryKey = 'new' | 'indeterminate' | 'done' | 'undefined';

export interface JiraBoardInfo {
  jiraBoardId: number;
  name: string;
  type: JiraBoardType;
  projectKey: string | null;
}

export interface JiraBoardConfig {
  filterId: number | null;
  estimationFieldId: string | null;
  estimationFieldName: string | null;
  columns: { name: string; statusIds: string[] }[];
}

export interface JiraStatusInfo {
  id: string;
  name: string;
  categoryKey: JiraStatusCategoryKey;
}

export interface JiraFieldInfo {
  id: string;
  name: string;
  /** schema.custom, e.g. com.pyxis.greenhopper.jira:gh-sprint; null for system fields. */
  custom: string | null;
}

export interface JiraSprintInfo {
  jiraSprintId: number;
  name: string;
  state: 'future' | 'active' | 'closed';
  startAt: Date | null;
  endAt: Date | null;
  completeAt: Date | null;
  goal: string | null;
  originBoardJiraId: number | null;
}

/**
 * One changelog item. Jira's `fromString`/`toString` are renamed `fromText`/`toText`: a property
 * read as `item.toString` returns Object.prototype.toString whenever Jira omits the key.
 */
export interface RawChangelogItem {
  field: string | null;
  fieldId: string | null;
  from: string | null;
  fromText: string | null;
  to: string | null;
  toText: string | null;
}

export interface RawChangelogHistory {
  id?: string;
  created: string;
  items: RawChangelogItem[];
}

/** An issue as Jira returns it from search (fields untyped: they depend on the site). */
export interface RawIssue {
  id: string;
  key: string;
  fields: Record<string, unknown>;
  changelog?: { total?: number; histories: RawChangelogHistory[] };
}

export interface NormalizedIssue {
  jiraIssueId: string;
  key: string;
  summary: string;
  issueType: string;
  isSubtask: boolean;
  statusId: string;
  assigneeId: string | null;
  assigneeName: string | null;
  estimate: number | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  transitions: { seq: number; at: Date; fromStatusId: string | null; toStatusId: string }[];
  changes: {
    seq: number;
    at: Date;
    kind: 'estimate' | 'flag';
    fromValue: string | null;
    toValue: string | null;
  }[];
  sprintMembership: { jiraSprintId: number; addedAt: Date; removedAt: Date | null }[];
}

/** Site-specific field ids needed to read an issue. */
export interface IssueFieldContext {
  estimationFieldId: string | null;
  estimationFieldName: string | null;
  sprintFieldId: string | null;
}
```

`packages/jira/src/issue-normalize.ts`:
```ts
import { z } from 'zod';
import type {
  IssueFieldContext,
  JiraFieldInfo,
  JiraStatusInfo,
  NormalizedIssue,
  RawChangelogHistory,
  RawChangelogItem,
  RawIssue,
} from './sync-types';

/** Jira timestamps look like 2026-10-03T10:00:00.000+0200; null when missing or unparseable. */
export function parseJiraDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const iso = value.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * Sprint ids from the Sprint field. Cloud (and recent DC) return objects with `id`; older Data
 * Center returns strings like "com.atlassian.greenhopper.service.sprint.Sprint@1a[id=12,...]".
 */
export function parseSprintField(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids = value.flatMap((v) => {
    if (typeof v === 'object' && v !== null && 'id' in v) {
      const id = Number((v as { id: unknown }).id);
      return Number.isInteger(id) ? [id] : [];
    }
    if (typeof v === 'string') {
      const m = /\bid=(\d+)/.exec(v);
      return m ? [Number(m[1])] : [];
    }
    return [];
  });
  return [...new Set(ids)];
}

/** Sprint ids in a changelog value such as "12, 13". */
export const parseSprintIds = (value: string | null | undefined): number[] => [
  ...new Set((value ?? '').match(/\d+/g)?.map(Number) ?? []),
];

/**
 * Turns the Sprint field's history into membership intervals. The set before the first change is
 * that change's `from` (the issue was created in those sprints); with no changes it is the
 * current value. Each change replaces the set with its `to`.
 */
export function deriveSprintMembership(
  createdAt: Date,
  current: number[],
  changes: { at: Date; from: number[]; to: number[] }[],
): NormalizedIssue['sprintMembership'] {
  const result: NormalizedIssue['sprintMembership'] = [];
  const open = new Map<number, Date>();
  for (const id of changes[0]?.from ?? current) open.set(id, createdAt);
  for (const change of changes) {
    const next = new Set(change.to);
    for (const [id, since] of open) {
      if (!next.has(id)) {
        result.push({ jiraSprintId: id, addedAt: since, removedAt: change.at });
        open.delete(id);
      }
    }
    for (const id of next) if (!open.has(id)) open.set(id, change.at);
  }
  for (const [id, since] of open)
    result.push({ jiraSprintId: id, addedAt: since, removedAt: null });
  return result.sort(
    (a, b) => a.jiraSprintId - b.jiraSprintId || a.addedAt.getTime() - b.addedAt.getTime(),
  );
}

const userSchema = z
  .looseObject({
    accountId: z.string().optional(),
    key: z.string().optional(),
    name: z.string().optional(),
    displayName: z.string().optional(),
  })
  .nullish();

const fieldsSchema = z.looseObject({
  summary: z.string().nullish(),
  issuetype: z.looseObject({ name: z.string(), subtask: z.boolean().optional() }).nullish(),
  status: z.looseObject({ id: z.string() }),
  assignee: userSchema,
  created: z.string(),
  updated: z.string(),
  resolutiondate: z.string().nullish(),
});

const isStatus = (i: RawChangelogItem) => i.fieldId === 'status' || i.field === 'status';
const isSprint = (i: RawChangelogItem) => i.field === 'Sprint';
const isFlag = (i: RawChangelogItem) => i.field === 'Flagged';
const flagValue = (v: string | null) => (v && v.trim() !== '' ? 'on' : 'off');

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/** Oldest first; ties keep Jira's id order. */
export function sortHistories(histories: RawChangelogHistory[]): RawChangelogHistory[] {
  return [...histories]
    .map((h) => ({ h, at: parseJiraDate(h.created)?.getTime() ?? 0, id: Number(h.id ?? 0) }))
    .sort((a, b) => a.at - b.at || a.id - b.id)
    .map((x) => x.h);
}

/** Reduces a raw issue plus its complete changelog to what the metrics need. */
export function normalizeIssue(
  raw: RawIssue,
  histories: RawChangelogHistory[],
  ctx: IssueFieldContext,
): NormalizedIssue {
  const f = fieldsSchema.parse(raw.fields);
  const createdAt = parseJiraDate(f.created);
  const updatedAt = parseJiraDate(f.updated);
  if (!createdAt || !updatedAt) throw new TypeError(`Issue ${raw.key} has unreadable dates`);

  const isEstimate = (i: RawChangelogItem) =>
    (ctx.estimationFieldId !== null && i.fieldId === ctx.estimationFieldId) ||
    (ctx.estimationFieldName !== null && i.field === ctx.estimationFieldName);

  const transitions: NormalizedIssue['transitions'] = [];
  const changes: NormalizedIssue['changes'] = [];
  const sprintChanges: { at: Date; from: number[]; to: number[] }[] = [];
  let seq = 0;
  for (const history of sortHistories(histories)) {
    const at = parseJiraDate(history.created);
    if (!at) continue;
    for (const item of history.items) {
      if (isStatus(item) && item.to) {
        transitions.push({ seq: seq++, at, fromStatusId: item.from, toStatusId: item.to });
      } else if (isSprint(item)) {
        sprintChanges.push({ at, from: parseSprintIds(item.from), to: parseSprintIds(item.to) });
      } else if (isFlag(item)) {
        changes.push({
          seq: seq++,
          at,
          kind: 'flag',
          fromValue: flagValue(item.fromText ?? item.from),
          toValue: flagValue(item.toText ?? item.to),
        });
      } else if (isEstimate(item)) {
        changes.push({
          seq: seq++,
          at,
          kind: 'estimate',
          fromValue: item.fromText ?? item.from,
          toValue: item.toText ?? item.to,
        });
      }
    }
  }

  const assignee = f.assignee ?? null;
  return {
    jiraIssueId: raw.id,
    key: raw.key,
    summary: f.summary ?? '',
    issueType: f.issuetype?.name ?? 'Issue',
    isSubtask: f.issuetype?.subtask ?? false,
    statusId: f.status.id,
    assigneeId: assignee ? (assignee.accountId ?? assignee.key ?? assignee.name ?? null) : null,
    assigneeName: assignee?.displayName ?? null,
    estimate: ctx.estimationFieldId ? toNumber(raw.fields[ctx.estimationFieldId]) : null,
    createdAt,
    updatedAt,
    resolvedAt: parseJiraDate(f.resolutiondate),
    transitions,
    changes,
    sprintMembership: deriveSprintMembership(
      createdAt,
      ctx.sprintFieldId ? parseSprintField(raw.fields[ctx.sprintFieldId]) : [],
      sprintChanges,
    ),
  };
}

/** The Sprint custom field (Jira Software), if the site has one. */
export const findSprintField = (fields: JiraFieldInfo[]): string | null =>
  fields.find((f) => f.custom === 'com.pyxis.greenhopper.jira:gh-sprint')?.id ?? null;

/** Fields to request from search so normalizeIssue has everything it reads. */
export const issueFieldList = (ctx: IssueFieldContext): string[] =>
  [
    'summary',
    'issuetype',
    'status',
    'assignee',
    'created',
    'updated',
    'resolutiondate',
    ctx.estimationFieldId,
    ctx.sprintFieldId,
  ].filter((f): f is string => Boolean(f));

const BLOCKED_NAME = /block|imped|on hold|waiting/i;

/** Default mapping from Jira's status category; "blocked"-sounding in-progress statuses are waits. */
export function suggestStatusMapping(status: JiraStatusInfo): {
  category: 'todo' | 'in_progress' | 'done';
  blocked: boolean;
} {
  if (status.categoryKey === 'new') return { category: 'todo', blocked: false };
  if (status.categoryKey === 'done') return { category: 'done', blocked: false };
  return { category: 'in_progress', blocked: BLOCKED_NAME.test(status.name) };
}

/** Minutes of overlap re-read on every incremental sync (clock skew, slow indexing). */
export const SYNC_OVERLAP_MINUTES = 15;

/**
 * JQL for a board's issues, oldest first. Incremental syncs use a RELATIVE date ("-75m"): absolute
 * JQL dates are read in the Jira user's time zone, which would shift the window by hours.
 */
export function buildIssueJql(filterId: number, since: Date | null, now: Date): string {
  const base = `filter = ${Math.trunc(filterId)}`;
  if (!since) return `${base} ORDER BY created ASC`;
  const minutes =
    Math.max(0, Math.ceil((now.getTime() - since.getTime()) / 60_000)) + SYNC_OVERLAP_MINUTES;
  return `${base} AND updated >= "-${minutes}m" ORDER BY created ASC`;
}
```

`packages/jira/src/responses.ts`:
```ts
// Lenient schemas for the Jira responses the sync reads. Only the fields we use are declared;
// everything else passes through, so a field Atlassian adds or drops elsewhere never breaks a sync.
import { z } from 'zod';
import { parseJiraDate } from './issue-normalize';
import type {
  JiraBoardConfig,
  JiraBoardInfo,
  JiraFieldInfo,
  JiraSprintInfo,
  JiraStatusInfo,
  RawChangelogHistory,
  RawChangelogItem,
  RawIssue,
} from './sync-types';

/** Reads only own string properties of Jira's raw item (see RawChangelogItem). */
function toItem(raw: Record<string, unknown>): RawChangelogItem {
  const own = (key: string) => {
    const value = Object.hasOwn(raw, key) ? raw[key] : null;
    return typeof value === 'string' && value !== '' ? value : null;
  };
  return {
    field: own('field'),
    fieldId: own('fieldId'),
    from: own('from'),
    fromText: own('fromString'),
    to: own('to'),
    toText: own('toString'),
  };
}

export const historySchema = z
  .looseObject({
    id: z.union([z.string(), z.number()]).optional(),
    created: z.string(),
    // Plain records: a declared `toString` key would match the inherited method on every item.
    items: z.array(z.record(z.string(), z.unknown())).default([]),
  })
  .transform(
    (h): RawChangelogHistory => ({
      id: h.id === undefined ? undefined : String(h.id),
      created: h.created,
      items: h.items.map(toItem),
    }),
  );

export const rawIssueSchema = z
  .looseObject({
    id: z.union([z.string(), z.number()]),
    key: z.string(),
    fields: z.record(z.string(), z.unknown()),
    changelog: z
      .looseObject({ total: z.number().optional(), histories: z.array(historySchema).default([]) })
      .optional(),
  })
  .transform(
    (i): RawIssue => ({ id: String(i.id), key: i.key, fields: i.fields, changelog: i.changelog }),
  );

const pageFields = {
  startAt: z.number().optional(),
  maxResults: z.number().optional(),
  total: z.number().optional(),
  isLast: z.boolean().optional(),
};

export const boardPageSchema = z.looseObject({
  ...pageFields,
  values: z
    .array(
      z.looseObject({
        id: z.number(),
        name: z.string(),
        type: z.string(),
        location: z.looseObject({ projectKey: z.string().optional() }).nullish(),
      }),
    )
    .default([]),
});

export const toBoardInfo = (
  b: z.infer<typeof boardPageSchema>['values'][number],
): JiraBoardInfo => ({
  jiraBoardId: b.id,
  name: b.name,
  type: b.type === 'scrum' || b.type === 'kanban' ? b.type : 'simple',
  projectKey: b.location?.projectKey ?? null,
});

export const boardConfigSchema = z
  .looseObject({
    filter: z.looseObject({ id: z.union([z.string(), z.number()]) }).nullish(),
    columnConfig: z
      .looseObject({
        columns: z
          .array(
            z.looseObject({
              name: z.string(),
              statuses: z
                .array(z.looseObject({ id: z.union([z.string(), z.number()]) }))
                .default([]),
            }),
          )
          .default([]),
      })
      .nullish(),
    estimation: z
      .looseObject({
        field: z.looseObject({ fieldId: z.string(), displayName: z.string().optional() }).nullish(),
      })
      .nullish(),
  })
  .transform(
    (c): JiraBoardConfig => ({
      filterId: c.filter ? Number(c.filter.id) : null,
      estimationFieldId: c.estimation?.field?.fieldId ?? null,
      estimationFieldName: c.estimation?.field?.displayName ?? null,
      columns: (c.columnConfig?.columns ?? []).map((col) => ({
        name: col.name,
        statusIds: col.statuses.map((s) => String(s.id)),
      })),
    }),
  );

export const sprintPageSchema = z.looseObject({
  ...pageFields,
  values: z
    .array(
      z
        .looseObject({
          id: z.number(),
          name: z.string(),
          state: z.string(),
          startDate: z.string().nullish(),
          endDate: z.string().nullish(),
          completeDate: z.string().nullish(),
          goal: z.string().nullish(),
          originBoardId: z.number().nullish(),
        })
        .transform(
          (s): JiraSprintInfo => ({
            jiraSprintId: s.id,
            name: s.name,
            state: s.state === 'active' || s.state === 'closed' ? s.state : 'future',
            startAt: parseJiraDate(s.startDate),
            endAt: parseJiraDate(s.endDate),
            completeAt: parseJiraDate(s.completeDate),
            goal: s.goal || null,
            originBoardJiraId: s.originBoardId ?? null,
          }),
        ),
    )
    .default([]),
});

const CATEGORY_KEYS = new Set(['new', 'indeterminate', 'done']);
export const statusListSchema = z.array(
  z
    .looseObject({
      id: z.union([z.string(), z.number()]),
      name: z.string(),
      statusCategory: z.looseObject({ key: z.string() }).nullish(),
    })
    .transform(
      (s): JiraStatusInfo => ({
        id: String(s.id),
        name: s.name,
        categoryKey: (CATEGORY_KEYS.has(s.statusCategory?.key ?? '')
          ? s.statusCategory?.key
          : 'undefined') as JiraStatusInfo['categoryKey'],
      }),
    ),
);

export const fieldListSchema = z.array(
  z
    .looseObject({
      id: z.string(),
      name: z.string(),
      schema: z.looseObject({ custom: z.string().optional() }).nullish(),
    })
    .transform(
      (f): JiraFieldInfo => ({ id: f.id, name: f.name, custom: f.schema?.custom ?? null }),
    ),
);

export const cloudSearchSchema = z.looseObject({
  issues: z.array(rawIssueSchema).default([]),
  nextPageToken: z.string().nullish(),
  isLast: z.boolean().optional(),
});

export const dcSearchSchema = z.looseObject({
  ...pageFields,
  issues: z.array(rawIssueSchema).default([]),
});

export const changelogPageSchema = z.looseObject({
  ...pageFields,
  values: z.array(historySchema).default([]),
});

export const issueChangelogSchema = z.looseObject({
  changelog: z.looseObject({ histories: z.array(historySchema).default([]) }).nullish(),
});

/** Stop paging when Jira says so, the page is empty, or the known total is reached. */
export function isLastPage(
  page:
    | z.infer<typeof boardPageSchema>
    | z.infer<typeof sprintPageSchema>
    | z.infer<typeof changelogPageSchema>
    | z.infer<typeof dcSearchSchema>,
  received: number,
  count: number,
): boolean {
  if (count === 0 || page.isLast === true) return true;
  return page.total !== undefined && received >= page.total;
}
```

`packages/jira/src/index.ts`:
```ts
export { mapJiraError } from './errors';
export {
  buildIssueJql,
  findSprintField,
  issueFieldList,
  normalizeIssue,
  parseJiraDate,
  SYNC_OVERLAP_MINUTES,
  suggestStatusMapping,
} from './issue-normalize';
export { inferDeployment, normalizeBaseUrl, normalizeCredentials } from './normalize';
export {
  ATLASSIAN_SCOPES,
  type AtlassianOAuthClient,
  type AtlassianSite,
  type AtlassianTokens,
  createAtlassianOAuth,
  listAccessibleJiraSites,
} from './oauth';
export { type ProbeOptions, probeJira } from './probe';
export type {
  IssueFieldContext,
  JiraBoardConfig,
  JiraBoardInfo,
  JiraBoardType,
  JiraFieldInfo,
  JiraSprintInfo,
  JiraStatusInfo,
  NormalizedIssue,
  RawChangelogHistory,
  RawIssue,
} from './sync-types';
export { type TestConnectionOptions, testJiraConnection } from './test-connection';
export type {
  JiraCredentials,
  JiraDeployment,
  JiraFailure,
  JiraFailureCode,
  JiraTestResult,
} from './types';
```

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `pnpm vitest run --project jira && pnpm lint && pnpm typecheck`
Expected: PASS — 48 tests (10 new).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(jira): normalise issue changelogs into transitions, changes and sprint membership

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Mock Jira agile/search endpoints and a seeded demo dataset

**Files:**
- Create: `packages/jira/src/testing/demo-dataset.ts`
- Modify: `packages/jira/src/testing/mock-jira-server.ts` (full rewrite, backwards compatible), `e2e/mocks/serve.ts`
- Test: `packages/jira/src/testing/demo-dataset.test.ts`

**Interfaces:**
- `demoDataset(anchor: Date): MockJiraDataset` — every date relative to 00:00 UTC of `anchor`'s day. Boards: **DEMO Scrum** (id 1, filter 101, story points `customfield_10016`, Sprint field `customfield_10020`, sprints 1–3 closed + 4 active, 25 issues) and **OPS Kanban** (id 2, filter 102, no estimates, 31 issues). Statuses: To Do `10000` (new), In Progress `3`, In Review `10001`, Blocked `10002` (indeterminate), Done `10003`. Exports `DEMO_STORY_POINTS`, `DEMO_SPRINT_FIELD`, `jiraTime`, types `MockJiraDataset`, `MockIssue`, `MockBoard`, `MockSprint`.
- Numbers the demo is built to produce (checked in Task 11 and e2e): Scrum — every closed sprint commits 20 pts and completes 19 → **average velocity 19, say/do 95 %, 2 pts added to the active sprint, 1 issue carried over**; Kanban — **3 finished per week (last 28 days), cycle time p85 8 days, 4 in progress, flow efficiency 83 %** ((92 − 16) / 92).
- `startMockJira(opts)` (unchanged options still work) gains: `dataset?`, `rateLimitFirst?` + `retryAfterSeconds?` (first N data requests answer 429), `maxPageSize?` (default 50), `searchChangelogLimit?` (truncate changelogs in search results; `total` stays complete), `now?`; `requests[]` entries now include `search`. Endpoints: Agile `board`, `board/{id}/configuration`, `board/{id}/sprint` (400 for Kanban), `rest/api/{2|3}/status`, `…/field`; Cloud `rest/api/3/search/jql` (page tokens) and `issue/{key}/changelog`; Data Center `rest/api/2/search` (offsets) and `issue/{key}?expand=changelog`. Supported JQL: `filter = N [AND updated >= "-Mm"]`.
- `e2e/mocks/serve.ts` serves `demoDataset(new Date())` on port 4010 (Data Center flavour, `Bearer good-pat`). The Phase 1 Jira e2e tests are unaffected.

- [ ] **Step 1: Write the failing test**

`packages/jira/src/testing/demo-dataset.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseJiraDate } from '../issue-normalize';
import { demoDataset } from './demo-dataset';

describe('demo dataset', () => {
  const ds = demoDataset(new Date('2026-10-04T15:30:00Z'));
  const time = (v: unknown) => parseJiraDate(v)?.getTime() ?? Number.NaN;

  it('has a Scrum board with 4 sprints and a Kanban board', () => {
    expect(ds.boards.map((b) => [b.name, b.type, b.filterId])).toEqual([
      ['DEMO Scrum', 'scrum', 101],
      ['OPS Kanban', 'kanban', 102],
    ]);
    expect(ds.sprints.map((s) => [s.name, s.state])).toEqual([
      ['DEMO Sprint 1', 'closed'],
      ['DEMO Sprint 2', 'closed'],
      ['DEMO Sprint 3', 'closed'],
      ['DEMO Sprint 4', 'active'],
    ]);
    expect(ds.issues.filter((i) => i.filterIds.includes(101))).toHaveLength(25);
    expect(ds.issues.filter((i) => i.filterIds.includes(102))).toHaveLength(31);
  });

  it('anchors dates to 00:00 UTC of the given day, all in the past except the active sprint end', () => {
    expect(ds.sprints[3]?.startDate).toBe('2026-09-27T10:00:00.000+0000');
    const now = Date.parse('2026-10-04T15:30:00Z');
    for (const issue of ds.issues) {
      expect(time(issue.fields.updated)).toBeLessThanOrEqual(now);
      for (const h of issue.histories)
        expect(time(h.created)).toBeGreaterThanOrEqual(time(issue.fields.created));
    }
  });

  it('keeps keys unique, histories in time order and statuses consistent with the changelog', () => {
    expect(new Set(ds.issues.map((i) => i.key)).size).toBe(ds.issues.length);
    const statusIds = new Set(ds.statuses.map((s) => s.id));
    for (const issue of ds.issues) {
      const times = issue.histories.map((h) => time(h.created));
      expect(times).toEqual([...times].sort((a, b) => a - b));
      const moves = issue.histories.flatMap((h) => h.items).filter((i) => i.field === 'status');
      const current = (issue.fields.status as { id: string }).id;
      expect(statusIds.has(current)).toBe(true);
      expect(moves.at(-1)?.to ?? '10000').toBe(current);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project jira src/testing/demo-dataset.test.ts`
Expected: FAIL — `Cannot find module './demo-dataset'`.

- [ ] **Step 3: Implement**

`packages/jira/src/testing/demo-dataset.ts`:
```ts
// Deterministic demo data served by the mock Jira (e2e and local review). Every date is relative to
// `anchor` (00:00 UTC of the day the mock starts), so the dashboards always look current.
//
// "DEMO Scrum" (board 1, filter 101, story points): sprints 1–3 closed, sprint 4 active.
//   Each closed sprint commits 20 pts (an issue carried in + 5 new: 5,3,3,3,3), finishes 19
//   (one 3-pt issue carried out, one 2-pt bug added and done) → average velocity 19, say/do 95%,
//   1 issue carried over from the last sprint, 2 pts added to the active sprint.
// "OPS Kanban" (board 2, filter 102, no estimates): 24 done issues with cycle times 1,2,3,4,5,8
//   days (×4) → cycle time p85 = 8 days; 12 finished in the last 28 days → 3 per week; the four
//   8-day issues spent 4 days Blocked → flow efficiency (92 − 16) / 92 = 83%; 4 in progress now.

export interface MockChangelogItem {
  field: string;
  fieldId?: string;
  fieldtype: string;
  from: string | null;
  fromString: string | null;
  to: string | null;
  toString: string | null;
}

export interface MockIssue {
  id: string;
  key: string;
  filterIds: number[];
  fields: Record<string, unknown>;
  histories: { id: string; created: string; items: MockChangelogItem[] }[];
}

export interface MockBoard {
  id: number;
  name: string;
  type: 'scrum' | 'kanban';
  projectKey: string;
  filterId: number;
  estimation: { fieldId: string; displayName: string } | null;
  columns: { name: string; statusIds: string[] }[];
}

export interface MockSprint {
  id: number;
  boardId: number;
  name: string;
  state: 'future' | 'active' | 'closed';
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  goal?: string;
}

export interface MockJiraDataset {
  boards: MockBoard[];
  statuses: { id: string; name: string; categoryKey: 'new' | 'indeterminate' | 'done' }[];
  fields: { id: string; name: string; custom: boolean; schemaCustom?: string }[];
  sprints: MockSprint[];
  issues: MockIssue[];
}

export const DEMO_STORY_POINTS = 'customfield_10016';
export const DEMO_SPRINT_FIELD = 'customfield_10020';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const STATUS = { todo: '10000', progress: '3', review: '10001', blocked: '10002', done: '10003' };
const STATUS_NAME: Record<string, string> = {
  [STATUS.todo]: 'To Do',
  [STATUS.progress]: 'In Progress',
  [STATUS.review]: 'In Review',
  [STATUS.blocked]: 'Blocked',
  [STATUS.done]: 'Done',
};
const PEOPLE = [
  { accountId: 'u-alex', key: 'alex', name: 'alex', displayName: 'Alex Martin' },
  { accountId: 'u-sam', key: 'sam', name: 'sam', displayName: 'Sam Leroy' },
  { accountId: 'u-kim', key: 'kim', name: 'kim', displayName: 'Kim Dubois' },
];

/** Jira's timestamp format, e.g. 2026-10-03T10:00:00.000+0000. */
export const jiraTime = (d: Date) => d.toISOString().replace('Z', '+0000');

interface IssueSpec {
  project: 'DEMO' | 'OPS';
  type: 'Story' | 'Bug' | 'Task';
  summary: string;
  created: Date;
  estimate?: number;
  assignee?: (typeof PEOPLE)[number] | null;
  /** Sprint field changes; the issue's sprints at creation are `initialSprints`. */
  initialSprints?: number[];
  sprintChanges?: { at: Date; to: number[] }[];
  /** Status changes after creation (the issue starts in To Do). */
  path?: [at: Date, statusId: string][];
}

export function demoDataset(anchor: Date): MockJiraDataset {
  const base = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  const at = (day: number, hour = 12, minute = 0) =>
    new Date(base + day * DAY + hour * HOUR + minute * 60_000);

  const sprints: MockSprint[] = [1, 2, 3, 4].map((k) => {
    const s = -49 + 14 * (k - 1);
    return {
      id: k,
      boardId: 1,
      name: `DEMO Sprint ${k}`,
      state: k <= 3 ? 'closed' : 'active',
      startDate: jiraTime(at(s, 10)),
      endDate: jiraTime(at(s + 14, 9)),
      ...(k <= 3 ? { completeDate: jiraTime(at(s + 14, 9)) } : {}),
      goal: `Sprint ${k} goal`,
    };
  });
  const sprintName = (id: number) => sprints.find((s) => s.id === id)?.name ?? `Sprint ${id}`;

  const counters = { DEMO: 0, OPS: 0 };
  let nextIssueId = 10_000;
  let nextHistoryId = 50_000;
  const issues: MockIssue[] = [];

  function add(spec: IssueSpec) {
    counters[spec.project]++;
    const histories: MockIssue['histories'] = [];
    const events: { at: Date; item: MockChangelogItem }[] = [];
    let sprintsNow = spec.initialSprints ?? [];
    for (const change of spec.sprintChanges ?? []) {
      events.push({
        at: change.at,
        item: {
          field: 'Sprint',
          fieldId: DEMO_SPRINT_FIELD,
          fieldtype: 'custom',
          from: sprintsNow.length ? sprintsNow.join(', ') : null,
          fromString: sprintsNow.length ? sprintsNow.map(sprintName).join(', ') : null,
          to: change.to.join(', '),
          toString: change.to.map(sprintName).join(', '),
        },
      });
      sprintsNow = change.to;
    }
    let status = STATUS.todo;
    for (const [when, to] of spec.path ?? []) {
      events.push({
        at: when,
        item: {
          field: 'status',
          fieldId: 'status',
          fieldtype: 'jira',
          from: status,
          fromString: STATUS_NAME[status] ?? null,
          to,
          toString: STATUS_NAME[to] ?? null,
        },
      });
      status = to;
    }
    events.sort((a, b) => a.at.getTime() - b.at.getTime());
    for (const e of events) {
      histories.push({ id: String(nextHistoryId++), created: jiraTime(e.at), items: [e.item] });
    }
    const last = events.at(-1)?.at ?? spec.created;
    const doneAt = status === STATUS.done ? last : null;
    issues.push({
      id: String(nextIssueId++),
      key: `${spec.project}-${counters[spec.project]}`,
      filterIds: [spec.project === 'DEMO' ? 101 : 102],
      fields: {
        summary: spec.summary,
        issuetype: { name: spec.type, subtask: false },
        status: { id: status, name: STATUS_NAME[status] },
        assignee: spec.assignee ?? null,
        created: jiraTime(spec.created),
        updated: jiraTime(last),
        resolutiondate: doneAt ? jiraTime(doneAt) : null,
        [DEMO_STORY_POINTS]: spec.estimate ?? null,
        [DEMO_SPRINT_FIELD]: sprintsNow.length
          ? sprintsNow.map((id) => ({
              id,
              name: sprintName(id),
              state: sprints.find((s) => s.id === id)?.state,
              boardId: 1,
            }))
          : null,
      },
      histories,
    });
  }

  // ---- DEMO Scrum ----
  const start = (k: number) => -49 + 14 * (k - 1);
  const s1 = start(1);
  add({
    project: 'DEMO',
    type: 'Story',
    summary: 'Set up the release pipeline',
    created: at(s1 - 2, 10),
    estimate: 3,
    assignee: PEOPLE[0],
    sprintChanges: [{ at: at(s1 - 1, 10), to: [1] }],
    path: [
      [at(s1 + 1, 10), STATUS.progress],
      [at(s1 + 3, 10), STATUS.review],
      [at(s1 + 3, 16), STATUS.done],
    ],
  });
  for (let k = 1; k <= 4; k++) {
    const s = start(k);
    [5, 3, 3, 3, 3].forEach((points, j) => {
      const common = {
        project: 'DEMO' as const,
        type: 'Story' as const,
        summary: `Sprint ${k} story ${j + 1}`,
        created: at(s - 2, 10),
        estimate: points,
        assignee: PEOPLE[j % PEOPLE.length],
      };
      const joined = { at: at(s - 1, 10), to: [k] };
      if (k <= 3 && j < 4) {
        add({
          ...common,
          sprintChanges: [joined],
          path: [
            [at(s + j + 1, 10), STATUS.progress],
            [at(s + j + 2, 10), STATUS.review],
            [at(s + j + 2, 15), STATUS.done],
          ],
        });
      } else if (k <= 3) {
        // Carried over: still in progress when sprint k closes, finished in sprint k + 1.
        const next = start(k + 1);
        add({
          ...common,
          sprintChanges: [joined, { at: at(next, 9, 1), to: [k, k + 1] }],
          path: [
            [at(s + 5, 10), STATUS.progress],
            [at(next + 3, 10), STATUS.review],
            [at(next + 3, 16), STATUS.done],
          ],
        });
      } else {
        // Active sprint 4: two done, one in progress (unassigned), two not started.
        const path: [Date, string][] =
          j === 0
            ? [
                [at(s + 1, 10), STATUS.progress],
                [at(s + 3, 15), STATUS.done],
              ]
            : j === 1
              ? [
                  [at(s + 2, 10), STATUS.progress],
                  [at(s + 4, 15), STATUS.done],
                ]
              : j === 2
                ? [[at(s + 4, 10), STATUS.progress]]
                : [];
        add({
          ...common,
          assignee: j === 2 ? null : common.assignee,
          sprintChanges: [joined],
          path,
        });
      }
    });
    // Added after the sprint started.
    add({
      project: 'DEMO',
      type: 'Bug',
      summary: `Sprint ${k} production bug`,
      created: at(s + 3, 11),
      estimate: 2,
      assignee: PEOPLE[1],
      initialSprints: [k],
      path:
        k <= 3
          ? [
              [at(s + 4, 10), STATUS.progress],
              [at(s + 6, 15), STATUS.done],
            ]
          : [],
    });
  }

  // ---- OPS Kanban ----
  const cycles = [1, 2, 3, 4, 5, 8];
  for (let i = 0; i < 24; i++) {
    const doneDay = i < 12 ? -(1 + 2 * i) : -(30 + 2 * (i - 12));
    const done = at(doneDay, 12);
    const ct = cycles[i % cycles.length] ?? 1;
    const started = new Date(done.getTime() - ct * DAY);
    const path: [Date, string][] =
      ct === 8
        ? [
            [started, STATUS.progress],
            [new Date(started.getTime() + 2 * DAY), STATUS.blocked],
            [new Date(started.getTime() + 6 * DAY), STATUS.progress],
            [done, STATUS.done],
          ]
        : [
            [started, STATUS.progress],
            [done, STATUS.done],
          ];
    add({
      project: 'OPS',
      type: 'Task',
      summary: `Ops request ${i + 1}`,
      created: new Date(started.getTime() - 2 * DAY),
      assignee: PEOPLE[i % PEOPLE.length],
      path,
    });
  }
  const inProgress: [startDay: number, blockedDay?: number][] = [[-3], [-6], [-10, -8], [-1]];
  inProgress.forEach(([startDay, blockedDay], n) => {
    const path: [Date, string][] = [[at(startDay, 10), STATUS.progress]];
    if (blockedDay !== undefined) path.push([at(blockedDay, 10), STATUS.blocked]);
    add({
      project: 'OPS',
      type: 'Task',
      summary: `Ops work in progress ${n + 1}`,
      created: at(startDay - 2, 10),
      assignee: PEOPLE[n % PEOPLE.length],
      path,
    });
  });
  for (let n = 0; n < 3; n++) {
    add({
      project: 'OPS',
      type: 'Task',
      summary: `Ops backlog item ${n + 1}`,
      created: at(-2, 9),
      assignee: null,
    });
  }

  return {
    boards: [
      {
        id: 1,
        name: 'DEMO Scrum',
        type: 'scrum',
        projectKey: 'DEMO',
        filterId: 101,
        estimation: { fieldId: DEMO_STORY_POINTS, displayName: 'Story Points' },
        columns: [
          { name: 'To Do', statusIds: [STATUS.todo] },
          { name: 'In Progress', statusIds: [STATUS.progress, STATUS.blocked] },
          { name: 'In Review', statusIds: [STATUS.review] },
          { name: 'Done', statusIds: [STATUS.done] },
        ],
      },
      {
        id: 2,
        name: 'OPS Kanban',
        type: 'kanban',
        projectKey: 'OPS',
        filterId: 102,
        estimation: null,
        columns: [
          { name: 'Backlog', statusIds: [STATUS.todo] },
          { name: 'In Progress', statusIds: [STATUS.progress] },
          { name: 'Blocked', statusIds: [STATUS.blocked] },
          { name: 'Done', statusIds: [STATUS.done] },
        ],
      },
    ],
    statuses: [
      { id: STATUS.todo, name: 'To Do', categoryKey: 'new' },
      { id: STATUS.progress, name: 'In Progress', categoryKey: 'indeterminate' },
      { id: STATUS.review, name: 'In Review', categoryKey: 'indeterminate' },
      { id: STATUS.blocked, name: 'Blocked', categoryKey: 'indeterminate' },
      { id: STATUS.done, name: 'Done', categoryKey: 'done' },
    ],
    fields: [
      { id: 'summary', name: 'Summary', custom: false },
      { id: 'status', name: 'Status', custom: false },
      {
        id: DEMO_STORY_POINTS,
        name: 'Story Points',
        custom: true,
        schemaCustom: 'com.atlassian.jira.plugin.system.customfieldtypes:float',
      },
      {
        id: DEMO_SPRINT_FIELD,
        name: 'Sprint',
        custom: true,
        schemaCustom: 'com.pyxis.greenhopper.jira:gh-sprint',
      },
    ],
    sprints,
    issues,
  };
}
```

`packages/jira/src/testing/mock-jira-server.ts`:
```ts
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseJiraDate } from '../issue-normalize';
import type { MockIssue, MockJiraDataset } from './demo-dataset';

export {
  DEMO_SPRINT_FIELD,
  DEMO_STORY_POINTS,
  demoDataset,
  type MockIssue,
  type MockJiraDataset,
} from './demo-dataset';

export interface MockJiraOptions {
  flavor: 'cloud' | 'datacenter';
  /** Exact Authorization header value that is accepted, e.g. "Bearer good-pat". */
  validAuthorization: string;
  /** e.g. "/jira" (DC context path) or "/ex/jira/cloud-123" (OAuth gateway). */
  pathPrefix?: string;
  /** Boards, sprints, statuses, fields and issues served by the agile/search endpoints. */
  dataset?: MockJiraDataset;
  /** Answer the first N data requests with 429 and a Retry-After header. */
  rateLimitFirst?: number;
  retryAfterSeconds?: number;
  /** Largest page served whatever maxResults asks (exercises pagination). Default 50. */
  maxPageSize?: number;
  /** Return at most this many changelog histories in search results (total stays complete). */
  searchChangelogLimit?: number;
  /** Clock for relative JQL dates. */
  now?: () => Date;
}

export interface MockJira {
  url: string;
  requests: { path: string; search: string; authorization?: string }[];
  close(): Promise<void>;
}

const CLOUD_MYSELF = {
  self: 'https://acme.atlassian.net/rest/api/3/user?accountId=acc-1',
  accountId: 'acc-1',
  accountType: 'atlassian',
  emailAddress: 'pm@acme.com',
  displayName: 'Pat Cloud',
  active: true,
  timeZone: 'Europe/Paris',
  locale: 'en_US',
  avatarUrls: {},
};
const CLOUD_SERVER_INFO = {
  baseUrl: 'https://acme.atlassian.net',
  version: '1001.0.0-SNAPSHOT',
  versionNumbers: [1001, 0, 0],
  deploymentType: 'Cloud',
  buildNumber: 100,
  buildDate: '2026-09-30T00:00:00.000+0000',
  serverTime: '2026-10-03T00:00:00.000+0000',
  scmInfo: 'abc',
  serverTitle: 'Jira',
  defaultLocale: { locale: 'en_US' },
};
const DC_MYSELF = { self: 'x', key: 'JIRAUSER1', name: 'pat', displayName: 'Pat DC', active: true };
const DC_SERVER_INFO = {
  baseUrl: 'https://jira.corp.example',
  version: '10.3.0',
  versionNumbers: [10, 3, 0],
  deploymentType: 'Server',
  buildNumber: 10030000,
  serverTitle: 'Corp Jira',
};

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** Issues matching `filter = N [AND updated >= "-Mm"]`, oldest first; null for unsupported JQL. */
function runJql(dataset: MockJiraDataset, jql: string, now: Date): MockIssue[] | null {
  const filter = /filter\s*=\s*(\d+)/i.exec(jql);
  if (!filter) return null;
  const filterId = Number(filter[1]);
  const since = /updated\s*>=\s*"-(\d+)m"/i.exec(jql);
  const from = since ? now.getTime() - Number(since[1]) * 60_000 : Number.NEGATIVE_INFINITY;
  const time = (v: unknown) => parseJiraDate(v)?.getTime() ?? 0;
  return dataset.issues
    .filter((i) => i.filterIds.includes(filterId) && time(i.fields.updated) >= from)
    .sort((a, b) => time(a.fields.created) - time(b.fields.created) || Number(a.id) - Number(b.id));
}

export async function startMockJira(opts: MockJiraOptions): Promise<MockJira> {
  const api = opts.flavor === 'cloud' ? '3' : '2';
  const prefix = opts.pathPrefix ?? '';
  const maxPage = opts.maxPageSize ?? 50;
  const now = opts.now ?? (() => new Date());
  const requests: MockJira['requests'] = [];
  let throttled = 0;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const path = url.pathname;
    const q = url.searchParams;
    requests.push({ path, search: url.search, authorization: req.headers.authorization });
    if (req.headers.authorization !== opts.validAuthorization) {
      return json(res, 401, { errorMessages: ['You are not authenticated.'] });
    }
    if (path === `${prefix}/rest/api/${api}/myself`) {
      return json(res, 200, opts.flavor === 'cloud' ? CLOUD_MYSELF : DC_MYSELF);
    }
    if (path === `${prefix}/rest/api/${api}/serverInfo`) {
      return json(res, 200, opts.flavor === 'cloud' ? CLOUD_SERVER_INFO : DC_SERVER_INFO);
    }
    const ds = opts.dataset;
    if (!ds) return json(res, 404, { errorMessages: ['Not found'] });
    if (throttled < (opts.rateLimitFirst ?? 0)) {
      throttled++;
      res.writeHead(429, { 'retry-after': String(opts.retryAfterSeconds ?? 1) });
      return res.end();
    }

    const startAt = Number(q.get('startAt') ?? 0);
    const size = Math.min(Number(q.get('maxResults') ?? maxPage), maxPage);
    const page = <T>(all: T[]) => ({
      startAt,
      maxResults: size,
      total: all.length,
      isLast: startAt + size >= all.length,
      values: all.slice(startAt, startAt + size),
    });
    const agile = `${prefix}/rest/agile/1.0/board`;

    if (path === agile) {
      return json(
        res,
        200,
        page(
          ds.boards.map((b) => ({
            id: b.id,
            name: b.name,
            type: b.type,
            location: { projectKey: b.projectKey, projectName: b.projectKey },
          })),
        ),
      );
    }
    const boardRoute = new RegExp(`^${agile}/(\\d+)/(configuration|sprint)$`).exec(path);
    if (boardRoute) {
      const board = ds.boards.find((b) => b.id === Number(boardRoute[1]));
      if (!board) return json(res, 404, { errorMessages: ['Board not found'] });
      if (boardRoute[2] === 'configuration') {
        return json(res, 200, {
          id: board.id,
          name: board.name,
          filter: { id: String(board.filterId) },
          columnConfig: {
            columns: board.columns.map((c) => ({
              name: c.name,
              statuses: c.statusIds.map((id) => ({ id })),
            })),
          },
          ...(board.estimation ? { estimation: { type: 'field', field: board.estimation } } : {}),
        });
      }
      if (board.type !== 'scrum') {
        return json(res, 400, { errorMessages: ['The board does not support sprints'] });
      }
      return json(
        res,
        200,
        page(
          ds.sprints
            .filter((s) => s.boardId === board.id)
            .map(({ boardId, ...s }) => ({ ...s, originBoardId: boardId })),
        ),
      );
    }
    if (path === `${prefix}/rest/api/${api}/status`) {
      return json(
        res,
        200,
        ds.statuses.map((s) => ({
          id: s.id,
          name: s.name,
          statusCategory: { key: s.categoryKey },
        })),
      );
    }
    if (path === `${prefix}/rest/api/${api}/field`) {
      return json(
        res,
        200,
        ds.fields.map((f) => ({
          id: f.id,
          name: f.name,
          custom: f.custom,
          ...(f.schemaCustom ? { schema: { type: 'any', custom: f.schemaCustom } } : {}),
        })),
      );
    }
    const issueJson = (i: MockIssue) => {
      const limit = opts.searchChangelogLimit ?? i.histories.length;
      return {
        id: i.id,
        key: i.key,
        fields: i.fields,
        changelog: {
          startAt: 0,
          maxResults: limit,
          total: i.histories.length,
          histories: i.histories.slice(0, limit),
        },
      };
    };
    const searchPath =
      opts.flavor === 'cloud' ? `${prefix}/rest/api/3/search/jql` : `${prefix}/rest/api/2/search`;
    if (path === searchPath) {
      const found = runJql(ds, q.get('jql') ?? '', now());
      if (!found) return json(res, 400, { errorMessages: ['Unsupported JQL in mock'] });
      if (opts.flavor === 'cloud') {
        const from = Number(q.get('nextPageToken') ?? 0);
        const slice = found.slice(from, from + size);
        const next = from + slice.length;
        return json(res, 200, {
          issues: slice.map(issueJson),
          ...(next < found.length ? { nextPageToken: String(next) } : {}),
          isLast: next >= found.length,
        });
      }
      return json(res, 200, {
        startAt,
        maxResults: size,
        total: found.length,
        issues: found.slice(startAt, startAt + size).map(issueJson),
      });
    }
    const changelog = new RegExp(`^${prefix}/rest/api/3/issue/([^/]+)/changelog$`).exec(path);
    if (changelog && opts.flavor === 'cloud') {
      const issue = ds.issues.find((i) => i.key === changelog[1] || i.id === changelog[1]);
      if (!issue) return json(res, 404, { errorMessages: ['Issue does not exist'] });
      return json(res, 200, page(issue.histories));
    }
    const single = new RegExp(`^${prefix}/rest/api/2/issue/([^/]+)$`).exec(path);
    if (single && opts.flavor === 'datacenter') {
      const issue = ds.issues.find((i) => i.key === single[1] || i.id === single[1]);
      if (!issue) return json(res, 404, { errorMessages: ['Issue does not exist'] });
      return json(res, 200, {
        id: issue.id,
        key: issue.key,
        fields: { status: issue.fields.status },
        changelog: {
          startAt: 0,
          maxResults: issue.histories.length,
          total: issue.histories.length,
          histories: issue.histories,
        },
      });
    }
    json(res, 404, { errorMessages: ['Not found'] });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${prefix}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // Clients keep connections alive; without this close() waits for the keep-alive timeout.
        server.closeAllConnections();
      }),
  };
}
```

`e2e/mocks/serve.ts`:
```diff
diff --git a/e2e/mocks/serve.ts b/e2e/mocks/serve.ts
--- a/e2e/mocks/serve.ts
+++ b/e2e/mocks/serve.ts
@@ -1,5 +1,5 @@
 import { createServer, request } from 'node:http';
-import { startMockJira } from '@agile/jira/testing';
+import { demoDataset, startMockJira } from '@agile/jira/testing';
 import { startMockOpenAI } from '@agile/llm/testing';
 
 // The mocks listen on random ports; expose them on fixed ports via a tiny reverse proxy.
@@ -18,7 +18,12 @@ async function expose(port: number, target: string) {
   await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
 }
 
-const jira = await startMockJira({ flavor: 'datacenter', validAuthorization: 'Bearer good-pat' });
+// Data Center flavour with the demo boards (dates relative to today) for the sync and dashboard tests.
+const jira = await startMockJira({
+  flavor: 'datacenter',
+  validAuthorization: 'Bearer good-pat',
+  dataset: demoDataset(new Date()),
+});
 const llm = await startMockOpenAI({ validKey: 'good-key' });
 await expose(4010, jira.url);
 await expose(4020, new URL(llm.baseUrl).origin);
```

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `pnpm vitest run --project jira && pnpm lint && pnpm typecheck`
Expected: PASS — 51 tests (the probe tests still use the mock without a dataset).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(jira): mock agile/search endpoints and a seeded demo dataset

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `@agile/jira` — Jira data source (Cloud v6 / Data Center v5), pagination, 429 retry

**Files:**
- Create: `packages/jira/src/rate-limit.ts`, `packages/jira/src/data-source.ts`
- Modify: `packages/jira/src/index.ts`
- Test: `packages/jira/src/rate-limit.test.ts`, `packages/jira/src/data-source.test.ts`

**Interfaces:**
- `interface JiraDataSource { listBoards(); getBoardConfig(jiraBoardId); listSprints(jiraBoardId) /* scrum only */; listStatuses(); listFields(); searchIssues(jql, fields): AsyncGenerator<RawIssue[]>; getFullChangelog(issueKey) }`
- `createJiraDataSource(creds: JiraCredentials, opts?: DataSourceOptions): JiraDataSource`, `DataSourceOptions { atlassianApiBase?; pageSize? (100); timeoutMs? (30 s); retry?: RetryOptions }`.
- `completeHistories(source, issue): Promise<RawChangelogHistory[]>` — the issue's changelog when complete, else `getFullChangelog` (Review Focus 3).
- `withRateLimitRetry(fn, { maxRetries?: 5, maxWaitMs?: 60_000, sleep? })` — retries 429/503, waiting `Retry-After` (seconds or HTTP date) or 1 s, 2 s, 4 s…; `errorStatus(e)` reads v6 `JiraHttpError`/v5 `HttpException` statuses; `errorRetryAfterMs(e)`.
- Index also exports `createNoRedirectClient`, `JiraHttpError`.

**Verified jira.js calls (type-checked against jira.js 6.2.0 and 5.4.0):**
```ts
// Cloud — jira.js v6 on our no-redirect client (lenient: we validate with our own schemas)
const client = createNoRedirectClient({ host, auth, schemaValidation: 'lenient' });
const jira = createCloudClient(client);   // import { createAgileClient, createCloudClient } from 'jira.js'
const agile = createAgileClient(client);
await agile.board.getAllBoards({ startAt, maxResults });            // GET /rest/agile/1.0/board → { values, isLast, total }
await agile.board.getConfiguration({ boardId });                    // filter.id, columnConfig.columns[].statuses[].id, estimation.field
await agile.board.getAllSprints({ boardId, startAt, maxResults });  // /rest/agile/1.0/board/{id}/sprint
await jira.workflowStatuses.getStatuses();                          // /rest/api/3/status
await jira.issueFields.getFields();                                 // /rest/api/3/field (schema.custom)
await jira.issueSearch.searchAndReconsileIssuesUsingJql({ jql, nextPageToken, maxResults, fields, expand: 'changelog' }); // /rest/api/3/search/jql
await jira.issues.getChangeLogs({ issueIdOrKey, startAt, maxResults });                // /rest/api/3/issue/{key}/changelog
// Data Center — jira.js v5 (axios), redirects disabled
const config = { host, authentication: { oauth2: { accessToken: pat } }, baseRequestConfig: { maxRedirects: 0, timeout } };
const v2 = new Version2Client(config);    // import { AgileClient, Version2Client } from 'jira-js-v5'
const ag = new AgileClient(config);
await ag.board.getAllBoards<unknown>({ startAt, maxResults }); await ag.board.getConfiguration<unknown>({ boardId });
await ag.board.getAllSprints<unknown>({ boardId, startAt, maxResults });
await v2.workflowStatuses.getStatuses<unknown>(); await v2.issueFields.getFields<unknown>();
await v2.issueSearch.searchForIssuesUsingJql<unknown>({ jql, startAt, maxResults, fields, expand: 'changelog' }); // /rest/api/2/search
await v2.issues.getIssue<unknown>({ issueIdOrKey, expand: 'changelog', fields: ['status'] });                // full changelog on DC
```
Board issues are read with JQL `filter = <board filter id>` rather than the board-issue endpoints: jira.js v6 maps those to Cloud-only `/rest/software/1.0/board/{id}/issue` (page tokens), so JQL keeps one code path for Cloud and Data Center.

**Ruling — Data Center validation.** No Data Center licence is available to this project, so "validated against a DC trial container" (spec) becomes: (1) the same contract test suite runs against a Cloud-flavoured and a Data Center-flavoured mock that reproduce each API's paging, error and changelog behaviour (this task); (2) a manual checklist against a real DC trial container and a Cloud sandbox, documented in the README (Task 14), run before relying on a Jira version. Cost if wrong: a real-DC quirk the mock does not reproduce (e.g. a field shape) surfaces only at the first manual run or with the first DC customer; lenient schemas and the string Sprint-field parser limit the blast radius.

- [ ] **Step 1: Write the failing tests**

`packages/jira/src/rate-limit.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { JiraHttpError } from './no-redirect-client';
import { errorRetryAfterMs, errorStatus, withRateLimitRetry } from './rate-limit';

const sleeps = () => {
  const waited: number[] = [];
  return { waited, sleep: async (ms: number) => void waited.push(ms) };
};

describe('withRateLimitRetry', () => {
  it('waits for Retry-After, then succeeds', async () => {
    const { waited, sleep } = sleeps();
    let calls = 0;
    const result = await withRateLimitRetry(
      async () => {
        calls++;
        if (calls < 3) throw new JiraHttpError(429, 2_000);
        return 'ok';
      },
      { sleep },
    );
    expect(result).toBe('ok');
    expect(waited).toEqual([2_000, 2_000]);
  });

  it('backs off exponentially without Retry-After and caps long waits', async () => {
    const { waited, sleep } = sleeps();
    await expect(
      withRateLimitRetry(
        async () => {
          throw new JiraHttpError(503);
        },
        { sleep, maxRetries: 3 },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(waited).toEqual([1_000, 2_000, 4_000]);

    const capped = sleeps();
    await expect(
      withRateLimitRetry(
        async () => {
          throw new JiraHttpError(429, 3_600_000);
        },
        { sleep: capped.sleep, maxRetries: 1, maxWaitMs: 60_000 },
      ),
    ).rejects.toBeInstanceOf(JiraHttpError);
    expect(capped.waited).toEqual([60_000]);
  });

  it('does not retry other failures', async () => {
    const { waited, sleep } = sleeps();
    await expect(
      withRateLimitRetry(
        async () => {
          throw new JiraHttpError(401);
        },
        { sleep },
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(waited).toEqual([]);
  });

  it('reads status and Retry-After from jira.js v5 (axios) errors', () => {
    const v5 = { status: 429, cause: { response: { headers: { 'retry-after': '4' } } } };
    expect(errorStatus(v5)).toBe(429);
    expect(errorRetryAfterMs(v5)).toBe(4_000);
    expect(errorStatus(new Error('x'))).toBeUndefined();
  });
});
```

`packages/jira/src/data-source.test.ts`:
```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { completeHistories, createJiraDataSource } from './data-source';
import { buildIssueJql, issueFieldList, normalizeIssue } from './issue-normalize';
import {
  DEMO_SPRINT_FIELD,
  demoDataset,
  type MockJira,
  startMockJira,
} from './testing/mock-jira-server';
import type { JiraCredentials } from './types';

const anchor = new Date('2026-10-04T00:00:00Z');
const now = new Date('2026-10-04T08:00:00Z');
const dataset = demoDataset(anchor);
const noWait = { sleep: async () => {} };

// The same contract runs against both flavours of the mock: Cloud (jira.js v6, REST v3,
// nextPageToken search) and Data Center (jira.js v5, REST v2, startAt search).
const flavours = [
  {
    flavor: 'cloud' as const,
    auth: `Basic ${Buffer.from('pm@acme.com:tok').toString('base64')}`,
    creds: (url: string): JiraCredentials => ({
      kind: 'cloud_basic',
      baseUrl: url,
      email: 'pm@acme.com',
      apiToken: 'tok',
    }),
  },
  {
    flavor: 'datacenter' as const,
    auth: 'Bearer good-pat',
    creds: (url: string): JiraCredentials => ({
      kind: 'datacenter_pat',
      baseUrl: url,
      token: 'good-pat',
    }),
  },
];

describe.each(flavours)('Jira data source contract ($flavor)', ({ flavor, auth, creds }) => {
  let mock: MockJira | undefined;
  afterEach(async () => {
    await mock?.close();
    mock = undefined;
  });

  const start = async (extra: Partial<Parameters<typeof startMockJira>[0]> = {}) => {
    mock = await startMockJira({
      flavor,
      validAuthorization: auth,
      pathPrefix: flavor === 'datacenter' ? '/jira' : '',
      dataset,
      now: () => now,
      ...extra,
    });
    return createJiraDataSource(creds(mock.url), { retry: noWait, pageSize: 10 });
  };

  it('lists boards, their configuration and sprints', async () => {
    const source = await start({ maxPageSize: 1 }); // forces board/sprint pagination
    expect(await source.listBoards()).toEqual([
      { jiraBoardId: 1, name: 'DEMO Scrum', type: 'scrum', projectKey: 'DEMO' },
      { jiraBoardId: 2, name: 'OPS Kanban', type: 'kanban', projectKey: 'OPS' },
    ]);
    expect(await source.getBoardConfig(1)).toEqual({
      filterId: 101,
      estimationFieldId: 'customfield_10016',
      estimationFieldName: 'Story Points',
      columns: [
        { name: 'To Do', statusIds: ['10000'] },
        { name: 'In Progress', statusIds: ['3', '10002'] },
        { name: 'In Review', statusIds: ['10001'] },
        { name: 'Done', statusIds: ['10003'] },
      ],
    });
    expect((await source.getBoardConfig(2)).estimationFieldId).toBeNull();
    const sprints = await source.listSprints(1);
    expect(sprints.map((s) => [s.jiraSprintId, s.state])).toEqual([
      [1, 'closed'],
      [2, 'closed'],
      [3, 'closed'],
      [4, 'active'],
    ]);
    expect(sprints[0]?.startAt).toEqual(new Date('2026-08-16T10:00:00Z'));
  });

  it('lists statuses with categories and finds the sprint field', async () => {
    const source = await start();
    expect((await source.listStatuses()).map((s) => [s.name, s.categoryKey])).toEqual([
      ['To Do', 'new'],
      ['In Progress', 'indeterminate'],
      ['In Review', 'indeterminate'],
      ['Blocked', 'indeterminate'],
      ['Done', 'done'],
    ]);
    expect((await source.listFields()).find((f) => f.id === DEMO_SPRINT_FIELD)?.custom).toBe(
      'com.pyxis.greenhopper.jira:gh-sprint',
    );
  });

  it('pages through a board search and completes truncated changelogs', async () => {
    const source = await start({ searchChangelogLimit: 1 });
    const ctx = {
      estimationFieldId: 'customfield_10016',
      estimationFieldName: 'Story Points',
      sprintFieldId: DEMO_SPRINT_FIELD,
    };
    const keys: string[] = [];
    let pages = 0;
    let transitions = 0;
    for await (const page of source.searchIssues(
      buildIssueJql(101, null, now),
      issueFieldList(ctx),
    )) {
      pages++;
      for (const issue of page) {
        keys.push(issue.key);
        const n = normalizeIssue(issue, await completeHistories(source, issue), ctx);
        transitions += n.transitions.length;
      }
    }
    const demo = dataset.issues.filter((i) => i.filterIds.includes(101));
    expect(keys).toHaveLength(demo.length); // 25 issues
    expect(pages).toBe(3); // 10 + 10 + 5
    expect(new Set(keys).size).toBe(keys.length);
    const expected = demo.reduce(
      (n, i) => n + i.histories.filter((h) => h.items[0]?.field === 'status').length,
      0,
    );
    expect(transitions).toBe(expected); // nothing lost to the truncated search changelog
  });

  it('only returns issues updated inside an incremental window', async () => {
    const source = await start();
    const since = new Date(now.getTime() - 3 * 86_400_000);
    const keys: string[] = [];
    for await (const page of source.searchIssues(buildIssueJql(102, since, now), ['summary'])) {
      keys.push(...page.map((i) => i.key));
    }
    const cutoff = since.getTime() - 15 * 60_000;
    const expected = dataset.issues
      .filter((i) => i.filterIds.includes(102))
      .filter((i) => Date.parse(String(i.fields.updated).replace('+0000', 'Z')) >= cutoff)
      .map((i) => i.key);
    expect(keys.sort()).toEqual(expected.sort());
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.length).toBeLessThan(31);
  });

  it('waits out 429 responses (Retry-After) and carries on', async () => {
    const waited: number[] = [];
    mock = await startMockJira({
      flavor,
      validAuthorization: auth,
      dataset,
      rateLimitFirst: 2,
      retryAfterSeconds: 3,
    });
    const source = createJiraDataSource(creds(mock.url), {
      retry: { sleep: async (ms) => void waited.push(ms) },
    });
    expect(await source.listBoards()).toHaveLength(2);
    expect(waited).toEqual([3_000, 3_000]);
  });

  it('refuses to follow redirects', async () => {
    const hits: string[] = [];
    const target: Server = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"values":[]}');
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    const redirector: Server = createServer((_req, res) => {
      res
        .writeHead(302, {
          location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/x`,
        })
        .end();
    });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
    try {
      const source = createJiraDataSource(
        creds(`http://127.0.0.1:${(redirector.address() as AddressInfo).port}`),
        {
          retry: noWait,
        },
      );
      await expect(source.listBoards()).rejects.toMatchObject({ status: 302 });
      expect(hits).toEqual([]);
    } finally {
      for (const s of [target, redirector]) {
        s.closeAllConnections();
        await new Promise((r) => s.close(r));
      }
    }
  });
});

describe('Jira data source (Cloud OAuth gateway)', () => {
  it('routes through api.atlassian.com/ex/jira/{cloudId} with a bearer token', async () => {
    const mock = await startMockJira({
      flavor: 'cloud',
      validAuthorization: 'Bearer access-1',
      pathPrefix: '/ex/jira/cloud-123',
      dataset,
    });
    try {
      const source = createJiraDataSource(
        {
          kind: 'cloud_oauth',
          baseUrl: 'https://acme.atlassian.net',
          cloudId: 'cloud-123',
          accessToken: 'access-1',
        },
        { atlassianApiBase: new URL(mock.url).origin, retry: noWait },
      );
      expect(await source.listBoards()).toHaveLength(2);
      expect(mock.requests.every((r) => r.path.startsWith('/ex/jira/cloud-123/'))).toBe(true);
    } finally {
      await mock.close();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project jira src/rate-limit.test.ts src/data-source.test.ts`
Expected: FAIL — `Cannot find module './rate-limit'` / `'./data-source'`.

- [ ] **Step 3: Implement**

`packages/jira/src/rate-limit.ts`:
```ts
import { parseRetryAfter } from './no-redirect-client';

export interface RetryOptions {
  /** Retries after the first attempt (default 5). */
  maxRetries?: number;
  /** Longest single wait (default 60 s); a longer Retry-After is capped. */
  maxWaitMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([429, 503]);

const field = (e: unknown, key: string): unknown =>
  typeof e === 'object' && e !== null ? (e as Record<string, unknown>)[key] : undefined;

/** HTTP status of a v6 (JiraHttpError) or v5 (HttpException / axios) error. */
export function errorStatus(e: unknown): number | undefined {
  const status = field(e, 'status') ?? field(field(e, 'response'), 'status');
  return typeof status === 'number' ? status : undefined;
}

/** Retry-After in ms: set directly by our v6 client, or read from the axios response headers (v5). */
export function errorRetryAfterMs(e: unknown): number | undefined {
  const direct = field(e, 'retryAfterMs');
  if (typeof direct === 'number') return direct;
  const headers =
    field(field(field(e, 'cause'), 'response'), 'headers') ??
    field(field(e, 'response'), 'headers');
  const value = field(headers, 'retry-after');
  return typeof value === 'string' ? parseRetryAfter(value) : undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs `fn`, retrying on 429/503: waits for Retry-After when Jira sends it (Jira Cloud does on
 * 429), otherwise 1 s, 2 s, 4 s… Gives up after `maxRetries` and rethrows the last error.
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 5;
  const maxWait = opts.maxWaitMs ?? 60_000;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const status = errorStatus(e);
      if (status === undefined || !RETRYABLE.has(status) || attempt >= maxRetries) throw e;
      await sleep(Math.min(errorRetryAfterMs(e) ?? 1000 * 2 ** attempt, maxWait));
    }
  }
}
```

`packages/jira/src/data-source.ts`:
```ts
import { createAgileClient, createCloudClient } from 'jira.js';
import { AgileClient, Version2Client } from 'jira-js-v5';
import { createNoRedirectClient } from './no-redirect-client';
import { type RetryOptions, withRateLimitRetry } from './rate-limit';
import {
  boardConfigSchema,
  boardPageSchema,
  changelogPageSchema,
  cloudSearchSchema,
  dcSearchSchema,
  fieldListSchema,
  isLastPage,
  issueChangelogSchema,
  sprintPageSchema,
  statusListSchema,
  toBoardInfo,
} from './responses';
import type {
  JiraBoardConfig,
  JiraBoardInfo,
  JiraFieldInfo,
  JiraSprintInfo,
  JiraStatusInfo,
  RawChangelogHistory,
  RawIssue,
} from './sync-types';
import type { JiraCredentials } from './types';

/** Read-only Jira access used by the sync. Same shape for Cloud (jira.js v6) and DC (v5). */
export interface JiraDataSource {
  listBoards(): Promise<JiraBoardInfo[]>;
  getBoardConfig(jiraBoardId: number): Promise<JiraBoardConfig>;
  /** Scrum boards only (Jira answers 400 for boards without sprints). */
  listSprints(jiraBoardId: number): Promise<JiraSprintInfo[]>;
  listStatuses(): Promise<JiraStatusInfo[]>;
  listFields(): Promise<JiraFieldInfo[]>;
  /** Pages of issues (with changelog, possibly truncated) for a JQL query. */
  searchIssues(jql: string, fields: string[]): AsyncGenerator<RawIssue[]>;
  /** Complete changelog of one issue. */
  getFullChangelog(issueKey: string): Promise<RawChangelogHistory[]>;
}

export interface DataSourceOptions {
  /** Atlassian API gateway origin (OAuth); overridable for tests. */
  atlassianApiBase?: string;
  /** Issues per search page (default 100). */
  pageSize?: number;
  /** Per-request deadline (default 30 s). */
  timeoutMs?: number;
  retry?: RetryOptions;
}

const PAGE = 50;

/** The issue's own changelog when complete, otherwise the full one fetched separately. */
export async function completeHistories(
  source: JiraDataSource,
  issue: RawIssue,
): Promise<RawChangelogHistory[]> {
  const log = issue.changelog;
  if (log && (log.total === undefined || log.total <= log.histories.length)) return log.histories;
  return source.getFullChangelog(issue.key);
}

export function createJiraDataSource(
  creds: JiraCredentials,
  opts: DataSourceOptions = {},
): JiraDataSource {
  return creds.kind === 'datacenter_pat' ? dataCenter(creds, opts) : cloud(creds, opts);
}

function cloud(
  c: Exclude<JiraCredentials, { kind: 'datacenter_pat' }>,
  opts: DataSourceOptions,
): JiraDataSource {
  const client = createNoRedirectClient({
    ...(c.kind === 'cloud_basic'
      ? { host: c.baseUrl, auth: { type: 'basic', email: c.email, apiToken: c.apiToken } }
      : {
          host: `${opts.atlassianApiBase ?? 'https://api.atlassian.com'}/ex/jira/${c.cloudId}`,
          auth: { type: 'bearer', token: c.accessToken },
        }),
    schemaValidation: 'lenient',
    timeoutMs: opts.timeoutMs,
  });
  const jira = createCloudClient(client);
  const agile = createAgileClient(client);
  const call = <T>(fn: () => Promise<T>) => withRateLimitRetry(fn, opts.retry);
  const pageSize = opts.pageSize ?? 100;

  return {
    async listBoards() {
      const boards: JiraBoardInfo[] = [];
      for (let startAt = 0; ; ) {
        const page = boardPageSchema.parse(
          await call(() => agile.board.getAllBoards({ startAt, maxResults: PAGE })),
        );
        boards.push(...page.values.map(toBoardInfo));
        startAt += page.values.length;
        if (isLastPage(page, startAt, page.values.length)) return boards;
      }
    },
    async getBoardConfig(boardId) {
      return boardConfigSchema.parse(await call(() => agile.board.getConfiguration({ boardId })));
    },
    async listSprints(boardId) {
      const sprints: JiraSprintInfo[] = [];
      for (let startAt = 0; ; ) {
        const page = sprintPageSchema.parse(
          await call(() => agile.board.getAllSprints({ boardId, startAt, maxResults: PAGE })),
        );
        sprints.push(...page.values);
        startAt += page.values.length;
        if (isLastPage(page, startAt, page.values.length)) return sprints;
      }
    },
    async listStatuses() {
      return statusListSchema.parse(await call(() => jira.workflowStatuses.getStatuses()));
    },
    async listFields() {
      return fieldListSchema.parse(await call(() => jira.issueFields.getFields()));
    },
    async *searchIssues(jql, fields) {
      let nextPageToken: string | undefined;
      do {
        const token = nextPageToken;
        const page = cloudSearchSchema.parse(
          await call(() =>
            jira.issueSearch.searchAndReconsileIssuesUsingJql({
              jql,
              nextPageToken: token,
              maxResults: pageSize,
              fields,
              expand: 'changelog',
            }),
          ),
        );
        if (page.issues.length > 0) yield page.issues;
        nextPageToken = page.isLast === true ? undefined : (page.nextPageToken ?? undefined);
      } while (nextPageToken);
    },
    async getFullChangelog(issueKey) {
      const histories: RawChangelogHistory[] = [];
      for (let startAt = 0; ; ) {
        const page = changelogPageSchema.parse(
          await call(() =>
            jira.issues.getChangeLogs({ issueIdOrKey: issueKey, startAt, maxResults: 100 }),
          ),
        );
        histories.push(...page.values);
        startAt += page.values.length;
        if (isLastPage(page, startAt, page.values.length)) return histories;
      }
    },
  };
}

function dataCenter(
  c: Extract<JiraCredentials, { kind: 'datacenter_pat' }>,
  opts: DataSourceOptions,
): JiraDataSource {
  const config = {
    host: c.baseUrl,
    authentication: { oauth2: { accessToken: c.token } },
    // Never follow redirects (SSRF); bound every request.
    baseRequestConfig: { maxRedirects: 0, timeout: opts.timeoutMs ?? 30_000 },
  };
  const v2 = new Version2Client(config);
  const agile = new AgileClient(config);
  const call = <T>(fn: () => Promise<T>) => withRateLimitRetry(fn, opts.retry);
  const pageSize = opts.pageSize ?? 100;

  return {
    async listBoards() {
      const boards: JiraBoardInfo[] = [];
      for (let startAt = 0; ; ) {
        const page = boardPageSchema.parse(
          await call(() => agile.board.getAllBoards<unknown>({ startAt, maxResults: PAGE })),
        );
        boards.push(...page.values.map(toBoardInfo));
        startAt += page.values.length;
        if (isLastPage(page, startAt, page.values.length)) return boards;
      }
    },
    async getBoardConfig(boardId) {
      return boardConfigSchema.parse(
        await call(() => agile.board.getConfiguration<unknown>({ boardId })),
      );
    },
    async listSprints(boardId) {
      const sprints: JiraSprintInfo[] = [];
      for (let startAt = 0; ; ) {
        const page = sprintPageSchema.parse(
          await call(() =>
            agile.board.getAllSprints<unknown>({ boardId, startAt, maxResults: PAGE }),
          ),
        );
        sprints.push(...page.values);
        startAt += page.values.length;
        if (isLastPage(page, startAt, page.values.length)) return sprints;
      }
    },
    async listStatuses() {
      return statusListSchema.parse(await call(() => v2.workflowStatuses.getStatuses<unknown>()));
    },
    async listFields() {
      return fieldListSchema.parse(await call(() => v2.issueFields.getFields<unknown>()));
    },
    async *searchIssues(jql, fields) {
      for (let startAt = 0; ; ) {
        const page = dcSearchSchema.parse(
          await call(() =>
            v2.issueSearch.searchForIssuesUsingJql<unknown>({
              jql,
              startAt,
              maxResults: pageSize,
              fields,
              expand: 'changelog',
            }),
          ),
        );
        if (page.issues.length > 0) yield page.issues;
        startAt += page.issues.length;
        if (isLastPage(page, startAt, page.issues.length)) return;
      }
    },
    async getFullChangelog(issueKey) {
      // Data Center returns the whole changelog with the issue.
      const issue = issueChangelogSchema.parse(
        await call(() =>
          v2.issues.getIssue<unknown>({
            issueIdOrKey: issueKey,
            expand: 'changelog',
            fields: ['status'],
          }),
        ),
      );
      return issue.changelog?.histories ?? [];
    },
  };
}
```

`packages/jira/src/index.ts`:
```ts
export {
  completeHistories,
  createJiraDataSource,
  type DataSourceOptions,
  type JiraDataSource,
} from './data-source';
export { mapJiraError } from './errors';
export {
  buildIssueJql,
  findSprintField,
  issueFieldList,
  normalizeIssue,
  parseJiraDate,
  SYNC_OVERLAP_MINUTES,
  suggestStatusMapping,
} from './issue-normalize';
export { createNoRedirectClient, JiraHttpError } from './no-redirect-client';
export { inferDeployment, normalizeBaseUrl, normalizeCredentials } from './normalize';
export {
  ATLASSIAN_SCOPES,
  type AtlassianOAuthClient,
  type AtlassianSite,
  type AtlassianTokens,
  createAtlassianOAuth,
  listAccessibleJiraSites,
} from './oauth';
export { type ProbeOptions, probeJira } from './probe';
export { errorStatus, type RetryOptions, withRateLimitRetry } from './rate-limit';
export type {
  IssueFieldContext,
  JiraBoardConfig,
  JiraBoardInfo,
  JiraBoardType,
  JiraFieldInfo,
  JiraSprintInfo,
  JiraStatusInfo,
  NormalizedIssue,
  RawChangelogHistory,
  RawIssue,
} from './sync-types';
export { type TestConnectionOptions, testJiraConnection } from './test-connection';
export type {
  JiraCredentials,
  JiraDeployment,
  JiraFailure,
  JiraFailureCode,
  JiraTestResult,
} from './types';
```

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `pnpm vitest run --project jira && pnpm lint && pnpm typecheck`
Expected: PASS — 68 tests: the contract (`describe.each`) runs 6 tests per flavour — boards/config/sprints with page size 1, statuses/fields, search pagination (25 issues in pages of 10+10+5) with every search changelog truncated to one history and nothing lost, the incremental window, two 429s waited out using `Retry-After` (3 s each), redirects refused — plus the OAuth gateway test.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(jira): Cloud and Data Center data source with pagination and 429 retries

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Part 2 — Sync engine, queue and worker

### Task 7: `@agile/sync` — board discovery, board selection, status mapping

**Files:**
- Create: `packages/sync/{package.json,tsconfig.json,vitest.config.ts}`, `packages/sync/src/{deps,credentials,persist,boards,index}.ts`, `packages/sync/src/test-harness.ts`
- Modify: `packages/connections/src/audit.ts` (new audit actions)
- Test: `packages/sync/src/boards.test.ts`

**Interfaces:**
- `SyncDeps extends ConnectionDeps { oauth?: AtlassianOAuthClient; createSource?; retry?: RetryOptions; now?: () => Date; onError?: (error, code) => void }`; `SyncFailureCode = JiraFailureCode | 'not_found' | 'no_boards' | 'already_running' | 'oauth_expired' | 'oauth_unavailable'`; `SyncFailure = { ok: false; code }`; `class SyncError(code)`.
- `resolveCredentials(deps, orgId, connectionId): Promise<JiraCredentials>` — OAuth connections go through `getFreshJiraCredentials` (refresh serialised per grant; `OAuthRefreshError`/`OAuthTimeoutError` → `oauth_expired`; no OAuth client configured → `oauth_unavailable`); other kinds re-run `checkOutboundUrl` first (DNS may have changed since the connection was tested) → `blocked_url`. `openDataSource(deps, orgId, connectionId): Promise<JiraDataSource>`.
- Boards: `discoverBoards(deps, actor, connectionId): Promise<{ ok: true; boards: BoardView[] } | SyncFailure>` (owner/admin; reads boards + configuration from Jira, upserts them keeping `selected`, removes boards Jira no longer returns, seeds suggested mappings for column statuses, audits `jira_boards.discovered`), `listBoards(deps, orgId, connectionId)`, `listSelectedBoards(deps, orgId)`, `getBoard(deps, orgId, boardId)`, `setBoardSelection(deps, actor, connectionId, boardIds)` (exactly those boards of that connection; audits `jira_boards.selection_changed`).
- Status mapping: `listStatusMappings(deps, orgId, boardId): StatusMappingView[]`, `saveStatusMappings(deps, actor, boardId, entries)` (source becomes `user`; `blocked` only kept for in-progress; unknown ids ignored; nothing updated → `not_found`; audits `jira_status_mapping.updated`).
- `getSyncState(deps, orgId, connectionId): SyncStateView` (`idle` when never synced).
- `BoardView { id; connectionId; jiraBoardId; name; type; projectKey; selected; usesEstimates; lastSyncedAt }`.
- Persistence helpers (used by Task 8): `saveBoardConfig`, `ensureStatusMappings` (insert suggested, never overwrite), `saveSprints`, `saveIssues` (upsert issues, link to the board, replace their transitions/changes/sprint membership), `pruneBoardIssues(tx, boardId, keep)` (one text parameter however large the board).
- `failureOf(deps, e): SyncFailure` — `SyncError` code, else `mapJiraError(e).code`; reports to `deps.onError`.
- Test harness (`@agile/sync/testing`): `startSyncHarness(mockOpts?)` → `{ tdb, db, rawDb, dataset, mock, deps, connect(actor?, name?), stop() }` (Testcontainers Postgres + Data Center mock serving the demo dataset at `NOW = 2026-10-04T08:00Z`, anchor `2026-10-04`), `owner(orgId?)`, `member(orgId?)`, `keyring`, `ANCHOR`, `NOW`.
- Audit actions added: `jira_boards.discovered`, `jira_boards.selection_changed`, `jira_status_mapping.updated`, `jira_sync.requested`.

- [ ] **Step 1: Package skeleton**

`packages/sync/package.json` (pg-boss is used from Task 9):
```json
{
  "name": "@agile/sync",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/test-harness.ts"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@agile/connections": "workspace:*",
    "@agile/crypto": "workspace:*",
    "@agile/db": "workspace:*",
    "@agile/jira": "workspace:*",
    "@agile/net": "workspace:*",
    "drizzle-orm": "0.45.3",
    "pg-boss": "12.36.0"
  },
  "devDependencies": {
    "@testcontainers/postgresql": "12.2.0"
  }
}
```

`packages/sync/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

`packages/sync/vitest.config.ts`:
```ts
import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'sync',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
```

`packages/connections/src/audit.ts`:
```diff
diff --git a/packages/connections/src/audit.ts b/packages/connections/src/audit.ts
--- a/packages/connections/src/audit.ts
+++ b/packages/connections/src/audit.ts
@@ -8,7 +8,11 @@ export type AuditAction =
   | 'llm_connection.created'
   | 'llm_connection.retested'
   | 'llm_connection.deleted'
-  | 'llm_connection.default_changed';
+  | 'llm_connection.default_changed'
+  | 'jira_boards.discovered'
+  | 'jira_boards.selection_changed'
+  | 'jira_status_mapping.updated'
+  | 'jira_sync.requested';
 
 /** metadata must never contain secrets — pass only non-sensitive descriptors. */
 export async function recordAudit(
```

- [ ] **Step 2: Harness and failing tests**

`packages/sync/src/test-harness.ts`:
```ts
import { type Actor, createJiraConnection } from '@agile/connections';
import { parseKeyring } from '@agile/crypto';
import { createDb } from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import {
  demoDataset,
  type MockJira,
  type MockJiraOptions,
  startMockJira,
} from '@agile/jira/testing';
import type { SyncDeps } from './deps';

export const keyring = parseKeyring(`v1:${Buffer.alloc(32, 7).toString('base64')}`);
export const owner = (orgId = 'org_a'): Actor => ({
  orgId,
  userId: `user_${orgId}`,
  roles: ['owner'],
});
export const member = (orgId = 'org_a'): Actor => ({ orgId, userId: 'user_m', roles: ['member'] });

export const ANCHOR = new Date('2026-10-04T00:00:00Z');
export const NOW = new Date('2026-10-04T08:00:00Z');

/** Postgres (Testcontainers) + a Data Center mock Jira serving the demo dataset. */
export async function startSyncHarness(mockOpts: Partial<MockJiraOptions> = {}) {
  const tdb: TestDatabase = await startTestDatabase();
  const app = createDb(tdb.appUrl, { max: 4 });
  const raw = createDb(tdb.ownerUrl, { max: 1 }); // bypasses RLS, to inspect rows
  const dataset = demoDataset(ANCHOR);
  const mock: MockJira = await startMockJira({
    flavor: 'datacenter',
    validAuthorization: 'Bearer good-pat',
    dataset,
    now: () => NOW,
    ...mockOpts,
  });
  const deps: SyncDeps = {
    db: app.db,
    keyring,
    allowedPrivateHosts: ['127.0.0.1'],
    retry: { sleep: async () => {} },
    now: () => NOW,
  };
  /** Creates (and tests) a DC connection to the mock; returns its id. */
  const connect = async (actor = owner(), name = 'Corp Jira') => {
    const r = await createJiraConnection(deps, actor, {
      name,
      credentials: { kind: 'datacenter_pat', baseUrl: mock.url, token: 'good-pat' },
    });
    if (!r.ok) throw new Error(`connect failed: ${r.code}`);
    return r.connection.id;
  };
  return {
    tdb,
    db: app.db,
    rawDb: raw.db,
    dataset,
    mock,
    deps,
    connect,
    stop: async () => {
      await mock.close();
      await app.close();
      await raw.close();
      await tdb.stop();
    },
  };
}
```

`packages/sync/src/boards.test.ts`:
```ts
import { ForbiddenError } from '@agile/connections';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  discoverBoards,
  listBoards,
  listStatusMappings,
  saveStatusMappings,
  setBoardSelection,
} from './boards';
import { member, owner, startSyncHarness } from './test-harness';

describe('boards and status mapping', () => {
  let h: Awaited<ReturnType<typeof startSyncHarness>>;
  let connectionId = '';
  beforeAll(async () => {
    h = await startSyncHarness();
    connectionId = await h.connect();
  });
  afterAll(async () => h?.stop());

  it('discovers boards with their configuration', async () => {
    const r = await discoverBoards(h.deps, owner(), connectionId);
    expect(r.ok && r.boards.map((b) => [b.name, b.type, b.usesEstimates, b.selected])).toEqual([
      ['DEMO Scrum', 'scrum', true, false],
      ['OPS Kanban', 'kanban', false, false],
    ]);
  });

  it('suggests a mapping for every column status from Jira categories', async () => {
    const [scrum] = await listBoards(h.deps, 'org_a', connectionId);
    const mappings = await listStatusMappings(h.deps, 'org_a', scrum?.id ?? '');
    expect(mappings.map((m) => [m.statusName, m.category, m.blocked, m.source])).toEqual([
      ['Blocked', 'in_progress', true, 'auto'],
      ['Done', 'done', false, 'auto'],
      ['In Progress', 'in_progress', false, 'auto'],
      ['In Review', 'in_progress', false, 'auto'],
      ['To Do', 'todo', false, 'auto'],
    ]);
  });

  it('saves the user mapping and keeps it when boards are rediscovered', async () => {
    const [scrum] = await listBoards(h.deps, 'org_a', connectionId);
    const boardId = scrum?.id ?? '';
    expect(
      await saveStatusMappings(h.deps, owner(), boardId, [
        { jiraStatusId: '10001', category: 'in_progress', blocked: true }, // In Review = waiting
        { jiraStatusId: '10003', category: 'done', blocked: true }, // blocked only applies in progress
      ]),
    ).toEqual({ ok: true, updated: 2 });
    await discoverBoards(h.deps, owner(), connectionId);
    const byName = Object.fromEntries(
      (await listStatusMappings(h.deps, 'org_a', boardId)).map((m) => [m.statusName, m]),
    );
    expect(byName['In Review']).toMatchObject({ blocked: true, source: 'user' });
    expect(byName.Done).toMatchObject({ category: 'done', blocked: false, source: 'user' });
    expect(
      await saveStatusMappings(h.deps, owner(), boardId, [
        { jiraStatusId: 'nope', category: 'done', blocked: false },
      ]),
    ).toEqual({ ok: false, code: 'not_found' });
  });

  it('selects exactly the given boards of this connection', async () => {
    const boards = await listBoards(h.deps, 'org_a', connectionId);
    const ids = boards.map((b) => b.id);
    const foreign = '00000000-0000-4000-8000-000000000000';
    expect(await setBoardSelection(h.deps, owner(), connectionId, [ids[0] ?? '', foreign])).toEqual(
      {
        ok: true,
        selected: 1,
      },
    );
    expect(await setBoardSelection(h.deps, owner(), connectionId, ids)).toEqual({
      ok: true,
      selected: 2,
    });
    expect((await listBoards(h.deps, 'org_a', connectionId)).every((b) => b.selected)).toBe(true);
  });

  it('is tenant-scoped and limited to owners and admins', async () => {
    expect(await listBoards(h.deps, 'org_b', connectionId)).toEqual([]);
    expect(await setBoardSelection(h.deps, owner('org_b'), connectionId, [])).toEqual({
      ok: false,
      code: 'not_found',
    });
    await expect(discoverBoards(h.deps, member(), connectionId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('reports Jira failures as codes', async () => {
    const other = await h.connect(owner('org_c'), 'Other');
    const broken = { ...h.deps, allowedPrivateHosts: [] }; // 127.0.0.1 is no longer allowed
    expect(await discoverBoards(broken, owner('org_c'), other)).toEqual({
      ok: false,
      code: 'blocked_url',
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm install && pnpm vitest run --project sync`
Expected: FAIL — `Cannot find module './boards'`.

- [ ] **Step 4: Implement**

`packages/sync/src/deps.ts`:
```ts
import type { ConnectionDeps } from '@agile/connections';
import type {
  AtlassianOAuthClient,
  DataSourceOptions,
  JiraCredentials,
  JiraDataSource,
  JiraFailureCode,
  RetryOptions,
} from '@agile/jira';

export interface SyncDeps extends ConnectionDeps {
  /** Atlassian OAuth client, needed to refresh "Connect with Atlassian" tokens. */
  oauth?: AtlassianOAuthClient;
  /** Swap the Jira client (tests). */
  createSource?: (creds: JiraCredentials, opts: DataSourceOptions) => JiraDataSource;
  retry?: RetryOptions;
  now?: () => Date;
  /** Called with every failure the sync turns into a stored code (log `e.name`, never `e.message`). */
  onError?: (error: unknown, code: SyncFailureCode) => void;
}

export type SyncFailureCode =
  | JiraFailureCode
  | 'not_found'
  | 'no_boards'
  | 'already_running'
  | 'oauth_expired'
  | 'oauth_unavailable';

export type SyncFailure = { ok: false; code: SyncFailureCode };

/** A failure with a stable code; the code (never the message) is what gets stored and shown. */
export class SyncError extends Error {
  override name = 'SyncError';
  constructor(readonly code: SyncFailureCode) {
    super(`Jira sync failed: ${code}`);
  }
}
```

`packages/sync/src/credentials.ts`:
```ts
import {
  getFreshJiraCredentials,
  loadJiraSecret,
  OAuthRefreshError,
  OAuthTimeoutError,
} from '@agile/connections';
import { jiraConnections, withOrg } from '@agile/db';
import { createJiraDataSource, type JiraCredentials, type JiraDataSource } from '@agile/jira';
import { checkOutboundUrl } from '@agile/net';
import { eq } from 'drizzle-orm';
import { type SyncDeps, SyncError } from './deps';

/**
 * Usable credentials for a stored connection. OAuth tokens are refreshed when due (serialised per
 * grant by getFreshJiraCredentials); for the other kinds the URL policy is checked again, because
 * the host's DNS may have changed since the connection was tested.
 */
export async function resolveCredentials(
  deps: SyncDeps,
  orgId: string,
  connectionId: string,
): Promise<JiraCredentials> {
  const [row] = await withOrg(deps.db, orgId, (tx) =>
    tx
      .select({ authType: jiraConnections.authType, baseUrl: jiraConnections.baseUrl })
      .from(jiraConnections)
      .where(eq(jiraConnections.id, connectionId)),
  );
  if (!row) throw new SyncError('not_found');
  if (row.authType === 'oauth') {
    if (!deps.oauth) throw new SyncError('oauth_unavailable');
    try {
      const creds = await getFreshJiraCredentials(
        { ...deps, oauth: deps.oauth },
        orgId,
        connectionId,
      );
      if (!creds) throw new SyncError('not_found');
      return creds;
    } catch (e) {
      if (e instanceof OAuthRefreshError || e instanceof OAuthTimeoutError) {
        throw new SyncError('oauth_expired');
      }
      throw e;
    }
  }
  const check = await checkOutboundUrl(row.baseUrl, deps);
  if (!check.ok) throw new SyncError('blocked_url');
  const secret = await loadJiraSecret(deps, orgId, connectionId);
  if (!secret) throw new SyncError('not_found');
  return secret.credentials;
}

export async function openDataSource(
  deps: SyncDeps,
  orgId: string,
  connectionId: string,
): Promise<JiraDataSource> {
  const creds = await resolveCredentials(deps, orgId, connectionId);
  return (deps.createSource ?? createJiraDataSource)(creds, {
    atlassianApiBase: deps.atlassianApiBase,
    retry: deps.retry,
  });
}
```

`packages/sync/src/persist.ts`:
```ts
import {
  type BoardColumn,
  jiraBoardIssues,
  jiraBoardSprints,
  jiraBoards,
  jiraIssueChanges,
  jiraIssues,
  jiraIssueTransitions,
  jiraSprintIssues,
  jiraSprints,
  jiraStatusMappings,
  type Tx,
} from '@agile/db';
import {
  type JiraBoardConfig,
  type JiraSprintInfo,
  type JiraStatusInfo,
  type NormalizedIssue,
  suggestStatusMapping,
} from '@agile/jira';
import { and, eq, inArray, sql } from 'drizzle-orm';

const excluded = (column: string) => sql.raw(`excluded.${column}`);

export async function saveBoardConfig(tx: Tx, boardId: string, config: JiraBoardConfig) {
  await tx
    .update(jiraBoards)
    .set({
      filterId: config.filterId,
      estimationFieldId: config.estimationFieldId,
      estimationFieldName: config.estimationFieldName,
      columns: config.columns satisfies BoardColumn[],
    })
    .where(eq(jiraBoards.id, boardId));
}

/** Adds a suggested mapping for every status the board doesn't map yet; existing ones are kept. */
export async function ensureStatusMappings(
  tx: Tx,
  orgId: string,
  boardId: string,
  statusIds: Iterable<string>,
  statuses: Map<string, JiraStatusInfo>,
) {
  const values = [...new Set(statusIds)].map((id) => {
    const status = statuses.get(id) ?? { id, name: id, categoryKey: 'undefined' as const };
    return {
      orgId,
      boardId,
      jiraStatusId: id,
      statusName: status.name,
      jiraCategory: status.categoryKey,
      ...suggestStatusMapping(status),
      source: 'auto' as const,
    };
  });
  if (values.length > 0) await tx.insert(jiraStatusMappings).values(values).onConflictDoNothing();
}

export async function saveSprints(
  tx: Tx,
  orgId: string,
  connectionId: string,
  boardId: string,
  sprints: JiraSprintInfo[],
) {
  if (sprints.length === 0) return;
  const rows = await tx
    .insert(jiraSprints)
    .values(sprints.map((s) => ({ orgId, connectionId, ...s })))
    .onConflictDoUpdate({
      target: [jiraSprints.connectionId, jiraSprints.jiraSprintId],
      set: {
        name: excluded('name'),
        state: excluded('state'),
        startAt: excluded('start_at'),
        endAt: excluded('end_at'),
        completeAt: excluded('complete_at'),
        goal: excluded('goal'),
        originBoardJiraId: excluded('origin_board_jira_id'),
      },
    })
    .returning({ id: jiraSprints.id });
  await tx
    .insert(jiraBoardSprints)
    .values(rows.map((r) => ({ orgId, boardId, sprintId: r.id })))
    .onConflictDoNothing();
}

/**
 * Upserts one page of issues, links them to the board and replaces their history (the full
 * changelog is re-read whenever an issue changes). Returns the stored issue ids.
 */
export async function saveIssues(
  tx: Tx,
  orgId: string,
  connectionId: string,
  boardId: string,
  issues: NormalizedIssue[],
): Promise<string[]> {
  if (issues.length === 0) return [];
  const rows = await tx
    .insert(jiraIssues)
    .values(
      issues.map((i) => ({
        orgId,
        connectionId,
        jiraIssueId: i.jiraIssueId,
        key: i.key,
        summary: i.summary,
        issueType: i.issueType,
        isSubtask: i.isSubtask,
        statusId: i.statusId,
        assigneeId: i.assigneeId,
        assigneeName: i.assigneeName,
        estimate: i.estimate,
        jiraCreatedAt: i.createdAt,
        jiraUpdatedAt: i.updatedAt,
        resolvedAt: i.resolvedAt,
        syncedAt: new Date(),
      })),
    )
    .onConflictDoUpdate({
      target: [jiraIssues.connectionId, jiraIssues.jiraIssueId],
      set: {
        key: excluded('key'),
        summary: excluded('summary'),
        issueType: excluded('issue_type'),
        isSubtask: excluded('is_subtask'),
        statusId: excluded('status_id'),
        assigneeId: excluded('assignee_id'),
        assigneeName: excluded('assignee_name'),
        estimate: excluded('estimate'),
        jiraCreatedAt: excluded('jira_created_at'),
        jiraUpdatedAt: excluded('jira_updated_at'),
        resolvedAt: excluded('resolved_at'),
        syncedAt: excluded('synced_at'),
      },
    })
    .returning({ id: jiraIssues.id, jiraIssueId: jiraIssues.jiraIssueId });
  const idOf = new Map(rows.map((r) => [r.jiraIssueId, r.id]));
  const ids = rows.map((r) => r.id);

  await tx
    .insert(jiraBoardIssues)
    .values(ids.map((issueId) => ({ orgId, boardId, issueId })))
    .onConflictDoNothing();
  await tx.delete(jiraIssueTransitions).where(inArray(jiraIssueTransitions.issueId, ids));
  await tx.delete(jiraIssueChanges).where(inArray(jiraIssueChanges.issueId, ids));
  await tx.delete(jiraSprintIssues).where(inArray(jiraSprintIssues.issueId, ids));

  const withId = issues.flatMap((i) => {
    const issueId = idOf.get(i.jiraIssueId);
    return issueId ? [{ issueId, i }] : [];
  });
  const transitions = withId.flatMap(({ issueId, i }) =>
    i.transitions.map((t) => ({ orgId, issueId, ...t })),
  );
  const changes = withId.flatMap(({ issueId, i }) =>
    i.changes.map((c) => ({ orgId, issueId, ...c })),
  );
  const membership = withId.flatMap(({ issueId, i }) =>
    i.sprintMembership.map((m) => ({ orgId, connectionId, issueId, ...m })),
  );
  if (transitions.length > 0) await tx.insert(jiraIssueTransitions).values(transitions);
  if (changes.length > 0) await tx.insert(jiraIssueChanges).values(changes);
  if (membership.length > 0) await tx.insert(jiraSprintIssues).values(membership);
  return ids;
}

/** After a full read of a board: unlink issues that no longer match its filter. */
export async function pruneBoardIssues(tx: Tx, boardId: string, keep: string[]) {
  await tx.delete(jiraBoardIssues).where(
    keep.length === 0
      ? eq(jiraBoardIssues.boardId, boardId)
      : and(
          eq(jiraBoardIssues.boardId, boardId),
          // One text parameter however large the board (a uuid list never contains a comma).
          sql`not (${jiraBoardIssues.issueId} = any(string_to_array(${keep.join(',')}, ',')::uuid[]))`,
        ),
  );
}
```

`packages/sync/src/boards.ts`:
```ts
import { type Actor, assertCanManage, recordAudit } from '@agile/connections';
import {
  jiraBoards,
  jiraConnections,
  jiraStatusMappings,
  jiraSyncStates,
  withOrg,
} from '@agile/db';
import {
  type JiraBoardConfig,
  type JiraBoardInfo,
  type JiraStatusInfo,
  mapJiraError,
} from '@agile/jira';
import { and, asc, eq, inArray, notInArray } from 'drizzle-orm';
import { openDataSource } from './credentials';
import { type SyncDeps, SyncError, type SyncFailure } from './deps';
import { ensureStatusMappings } from './persist';

export interface BoardView {
  id: string;
  connectionId: string;
  jiraBoardId: number;
  name: string;
  type: 'scrum' | 'kanban' | 'simple';
  projectKey: string | null;
  selected: boolean;
  usesEstimates: boolean;
  lastSyncedAt: Date | null;
}

export interface StatusMappingView {
  jiraStatusId: string;
  statusName: string;
  jiraCategory: string;
  category: 'todo' | 'in_progress' | 'done';
  blocked: boolean;
  source: 'auto' | 'user';
}

export interface SyncStateView {
  status: 'idle' | 'queued' | 'running' | 'ok' | 'error';
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
}

const toBoardView = (b: typeof jiraBoards.$inferSelect): BoardView => ({
  id: b.id,
  connectionId: b.connectionId,
  jiraBoardId: b.jiraBoardId,
  name: b.name,
  type: b.type,
  projectKey: b.projectKey,
  selected: b.selected,
  usesEstimates: b.estimationFieldId !== null,
  lastSyncedAt: b.lastSyncedAt,
});

/** Maps an error to a stable code (reported to deps.onError for logging). */
export function failureOf(deps: SyncDeps, e: unknown): SyncFailure {
  const code = e instanceof SyncError ? e.code : mapJiraError(e).code;
  deps.onError?.(e, code);
  return { ok: false, code };
}

export async function listBoards(
  deps: SyncDeps,
  orgId: string,
  connectionId: string,
): Promise<BoardView[]> {
  const rows = await withOrg(deps.db, orgId, (tx) =>
    tx
      .select()
      .from(jiraBoards)
      .where(eq(jiraBoards.connectionId, connectionId))
      .orderBy(asc(jiraBoards.name)),
  );
  return rows.map(toBoardView);
}

/** All selected boards of the workspace (dashboard navigation). */
export async function listSelectedBoards(deps: SyncDeps, orgId: string): Promise<BoardView[]> {
  const rows = await withOrg(deps.db, orgId, (tx) =>
    tx.select().from(jiraBoards).where(eq(jiraBoards.selected, true)).orderBy(asc(jiraBoards.name)),
  );
  return rows.map(toBoardView);
}

export async function getBoard(deps: SyncDeps, orgId: string, boardId: string) {
  const [row] = await withOrg(deps.db, orgId, (tx) =>
    tx.select().from(jiraBoards).where(eq(jiraBoards.id, boardId)),
  );
  return row ? toBoardView(row) : null;
}

/**
 * Reads the connection's boards from Jira and stores them with their configuration (selection is
 * kept). Boards Jira no longer returns are removed with everything synced for them. Statuses of
 * each board's columns get a suggested mapping unless one exists.
 */
export async function discoverBoards(
  deps: SyncDeps,
  actor: Actor,
  connectionId: string,
): Promise<{ ok: true; boards: BoardView[] } | SyncFailure> {
  assertCanManage(actor);
  const found: { info: JiraBoardInfo; config: JiraBoardConfig }[] = [];
  let statuses: JiraStatusInfo[];
  try {
    const source = await openDataSource(deps, actor.orgId, connectionId);
    statuses = await source.listStatuses();
    // One board at a time: Jira rate-limits bursts.
    for (const info of await source.listBoards()) {
      found.push({ info, config: await source.getBoardConfig(info.jiraBoardId) });
    }
  } catch (e) {
    return failureOf(deps, e);
  }
  const statusById = new Map(statuses.map((s) => [s.id, s]));
  await withOrg(deps.db, actor.orgId, async (tx) => {
    for (const { info, config } of found) {
      const [board] = await tx
        .insert(jiraBoards)
        .values({
          orgId: actor.orgId,
          connectionId,
          jiraBoardId: info.jiraBoardId,
          name: info.name,
          type: info.type,
          projectKey: info.projectKey,
          filterId: config.filterId,
          estimationFieldId: config.estimationFieldId,
          estimationFieldName: config.estimationFieldName,
          columns: config.columns,
        })
        .onConflictDoUpdate({
          target: [jiraBoards.connectionId, jiraBoards.jiraBoardId],
          set: {
            name: info.name,
            type: info.type,
            projectKey: info.projectKey,
            filterId: config.filterId,
            estimationFieldId: config.estimationFieldId,
            estimationFieldName: config.estimationFieldName,
            columns: config.columns,
          },
        })
        .returning({ id: jiraBoards.id });
      if (!board) continue;
      await ensureStatusMappings(
        tx,
        actor.orgId,
        board.id,
        config.columns.flatMap((c) => c.statusIds),
        statusById,
      );
    }
    const keep = found.map((f) => f.info.jiraBoardId);
    await tx
      .delete(jiraBoards)
      .where(
        keep.length === 0
          ? eq(jiraBoards.connectionId, connectionId)
          : and(
              eq(jiraBoards.connectionId, connectionId),
              notInArray(jiraBoards.jiraBoardId, keep),
            ),
      );
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'jira_boards.discovered',
      targetType: 'jira_connection',
      targetId: connectionId,
      metadata: { boards: found.length },
    });
  });
  return { ok: true, boards: await listBoards(deps, actor.orgId, connectionId) };
}

/** Selects exactly `boardIds` (ids of this connection's boards; others are ignored). */
export async function setBoardSelection(
  deps: SyncDeps,
  actor: Actor,
  connectionId: string,
  boardIds: string[],
): Promise<{ ok: true; selected: number } | SyncFailure> {
  assertCanManage(actor);
  return withOrg(deps.db, actor.orgId, async (tx) => {
    const [conn] = await tx
      .select({ id: jiraConnections.id })
      .from(jiraConnections)
      .where(eq(jiraConnections.id, connectionId));
    if (!conn) return { ok: false, code: 'not_found' } as const;
    await tx
      .update(jiraBoards)
      .set({ selected: false })
      .where(eq(jiraBoards.connectionId, connectionId));
    const selected =
      boardIds.length === 0
        ? []
        : await tx
            .update(jiraBoards)
            .set({ selected: true })
            .where(and(eq(jiraBoards.connectionId, connectionId), inArray(jiraBoards.id, boardIds)))
            .returning({ id: jiraBoards.id });
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'jira_boards.selection_changed',
      targetType: 'jira_connection',
      targetId: connectionId,
      metadata: { selected: selected.length },
    });
    return { ok: true, selected: selected.length } as const;
  });
}

export async function listStatusMappings(
  deps: SyncDeps,
  orgId: string,
  boardId: string,
): Promise<StatusMappingView[]> {
  const rows = await withOrg(deps.db, orgId, (tx) =>
    tx
      .select()
      .from(jiraStatusMappings)
      .where(eq(jiraStatusMappings.boardId, boardId))
      .orderBy(asc(jiraStatusMappings.statusName)),
  );
  return rows.map((r) => ({
    jiraStatusId: r.jiraStatusId,
    statusName: r.statusName,
    jiraCategory: r.jiraCategory,
    category: r.category,
    blocked: r.blocked,
    source: r.source,
  }));
}

/** Saves the user's mapping for statuses the board already knows; unknown status ids are ignored. */
export async function saveStatusMappings(
  deps: SyncDeps,
  actor: Actor,
  boardId: string,
  entries: { jiraStatusId: string; category: 'todo' | 'in_progress' | 'done'; blocked: boolean }[],
): Promise<{ ok: true; updated: number } | SyncFailure> {
  assertCanManage(actor);
  return withOrg(deps.db, actor.orgId, async (tx) => {
    let updated = 0;
    for (const e of entries) {
      const rows = await tx
        .update(jiraStatusMappings)
        .set({
          category: e.category,
          // Only in-progress statuses can be waits; done/to-do time is not part of cycle time.
          blocked: e.category === 'in_progress' && e.blocked,
          source: 'user',
        })
        .where(
          and(
            eq(jiraStatusMappings.boardId, boardId),
            eq(jiraStatusMappings.jiraStatusId, e.jiraStatusId),
          ),
        )
        .returning({ id: jiraStatusMappings.jiraStatusId });
      updated += rows.length;
    }
    if (updated === 0) return { ok: false, code: 'not_found' } as const;
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'jira_status_mapping.updated',
      targetType: 'jira_board',
      targetId: boardId,
      metadata: { statuses: updated },
    });
    return { ok: true, updated } as const;
  });
}

export async function getSyncState(
  deps: SyncDeps,
  orgId: string,
  connectionId: string,
): Promise<SyncStateView> {
  const [row] = await withOrg(deps.db, orgId, (tx) =>
    tx.select().from(jiraSyncStates).where(eq(jiraSyncStates.connectionId, connectionId)),
  );
  return {
    status: row?.status ?? 'idle',
    lastStartedAt: row?.lastStartedAt ?? null,
    lastFinishedAt: row?.lastFinishedAt ?? null,
    lastSuccessAt: row?.lastSuccessAt ?? null,
    lastError: row?.lastError ?? null,
  };
}
```

`packages/sync/src/index.ts`:
```ts
export {
  type BoardView,
  discoverBoards,
  getBoard,
  getSyncState,
  listBoards,
  listSelectedBoards,
  listStatusMappings,
  type StatusMappingView,
  type SyncStateView,
  saveStatusMappings,
  setBoardSelection,
} from './boards';
export { resolveCredentials } from './credentials';
export { type SyncDeps, SyncError, type SyncFailure, type SyncFailureCode } from './deps';
```

- [ ] **Step 5: Run tests, lint, typecheck**

Run: `pnpm vitest run --project sync && pnpm lint && pnpm typecheck`
Expected: PASS — 6 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(sync): board discovery, board selection and status mapping services

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `@agile/sync` — `runSync`, incremental with a daily full re-read

**Files:**
- Create: `packages/sync/src/run-sync.ts`
- Modify: `packages/sync/src/index.ts`
- Test: `packages/sync/src/run-sync.test.ts`

**Interfaces:**
- `runSync(deps: SyncDeps, job: SyncJob): Promise<SyncOutcome>`; `SyncJob { orgId; connectionId; trigger: 'manual' | 'schedule' }`; `SyncOutcome = { ok: true; mode: 'full' | 'incremental'; boards; issues } | SyncFailure`; `FULL_SYNC_EVERY_MS = 24 h`.
- Never throws for Jira or credential problems: the outcome and `jira_sync_states` carry a code; every run is a `jira_sync_runs` row.

**Algorithm:**
1. **Lease** (Review Focus 5): in one `withOrg` transaction, create the state row if missing and set `status = 'running'` only if it is not already running (or the running lease is older than an hour — a crashed worker). No row updated → `already_running`. The run row is inserted in the same transaction.
2. **Mode:** `full` when there is no watermark, no full sync yet, or the last full sync is ≥ 24 h old; otherwise `incremental` from `watermark` (the *start* time of the last successful sync, our clock) with the 15-minute overlap and relative JQL from Task 4.
3. No selected board → `no_boards`. Credentials via `openDataSource` (OAuth refresh / URL re-check). Fields → Sprint field id; statuses once per run.
4. Per selected board: configuration (a 404 means the board is gone: skipped); sprints for Scrum boards; suggested mappings for column statuses; then each search page is normalised (full changelog when truncated) and saved in its own transaction; statuses seen in issues get suggested mappings too. A **full** read then prunes board membership of issues that no longer match the filter.
5. Success → `status ok`, new watermark = this run's start, `lastFullSyncAt` updated on full runs. Failure → `status error`, `lastError` = code.

**Ruling — membership pruning cadence.** Incremental JQL cannot see issues that *left* a board's filter, so membership is reconciled by the daily full read. Cost if wrong: an issue moved off a board lingers on its dashboards for up to 24 h.

- [ ] **Step 1: Write the failing tests**

`packages/sync/src/run-sync.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { createJiraConnection } from '@agile/connections';
import {
  jiraBoardIssues,
  jiraBoards,
  jiraIssues,
  jiraIssueTransitions,
  jiraSprintIssues,
  jiraSprints,
  jiraSyncRuns,
  jiraSyncStates,
} from '@agile/db';
import type { AtlassianOAuthClient } from '@agile/jira';
import { startMockJira } from '@agile/jira/testing';
import { and, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverBoards, listBoards, setBoardSelection } from './boards';
import { runSync } from './run-sync';
import { NOW, owner, startSyncHarness } from './test-harness';

describe('runSync', () => {
  let h: Awaited<ReturnType<typeof startSyncHarness>>;
  let connectionId = '';
  const job = () => ({ orgId: 'org_a', connectionId, trigger: 'manual' as const });
  const boardIssueCount = async (name: string) => {
    const [row] = await h.rawDb
      .select({ n: count() })
      .from(jiraBoardIssues)
      .innerJoin(jiraBoards, eq(jiraBoards.id, jiraBoardIssues.boardId))
      .where(eq(jiraBoards.name, name));
    return row?.n ?? 0;
  };

  beforeAll(async () => {
    h = await startSyncHarness();
    connectionId = await h.connect();
    await discoverBoards(h.deps, owner(), connectionId);
  });
  afterAll(async () => h?.stop());

  it('refuses to sync a connection without selected boards', async () => {
    expect(await runSync(h.deps, job())).toEqual({ ok: false, code: 'no_boards' });
  });

  it('first sync reads both boards completely', async () => {
    const boards = await listBoards(h.deps, 'org_a', connectionId);
    await setBoardSelection(
      h.deps,
      owner(),
      connectionId,
      boards.map((b) => b.id),
    );
    expect(await runSync(h.deps, job())).toEqual({ ok: true, mode: 'full', boards: 2, issues: 56 });
    expect(await boardIssueCount('DEMO Scrum')).toBe(25);
    expect(await boardIssueCount('OPS Kanban')).toBe(31);

    const sprints = await h.rawDb.select().from(jiraSprints).orderBy(jiraSprints.jiraSprintId);
    expect(sprints.map((s) => [s.name, s.state])).toEqual([
      ['DEMO Sprint 1', 'closed'],
      ['DEMO Sprint 2', 'closed'],
      ['DEMO Sprint 3', 'closed'],
      ['DEMO Sprint 4', 'active'],
    ]);
    // The story carried out of sprint 1 belongs to sprints 1 and 2.
    const [carried] = await h.rawDb.select().from(jiraIssues).where(eq(jiraIssues.key, 'DEMO-6'));
    const membership = await h.rawDb
      .select({ sprint: jiraSprintIssues.jiraSprintId, removedAt: jiraSprintIssues.removedAt })
      .from(jiraSprintIssues)
      .where(eq(jiraSprintIssues.issueId, carried?.id ?? ''));
    expect(membership.sort((a, b) => a.sprint - b.sprint)).toEqual([
      { sprint: 1, removedAt: null },
      { sprint: 2, removedAt: null },
    ]);
    const transitions = await h.rawDb
      .select()
      .from(jiraIssueTransitions)
      .where(eq(jiraIssueTransitions.issueId, carried?.id ?? ''));
    expect(transitions.map((t) => t.toStatusId)).toEqual(['3', '10001', '10003']);

    const [state] = await h.rawDb.select().from(jiraSyncStates);
    expect(state).toMatchObject({
      status: 'ok',
      watermark: NOW,
      lastFullSyncAt: NOW,
      lastError: null,
    });
    const runs = await h.rawDb.select().from(jiraSyncRuns);
    // The earlier attempt without selected boards was recorded as a failed run.
    expect(runs.map((r) => r.error).sort()).toEqual(['no_boards', null]);
    const run = runs.find((r) => r.status === 'ok');
    expect(run).toMatchObject({
      status: 'ok',
      mode: 'full',
      trigger: 'manual',
      boardsSynced: 2,
      issuesUpserted: 56,
    });
  });

  it('next sync is incremental with a relative, overlapping JQL window', async () => {
    const later = new Date(NOW.getTime() + 30 * 60_000);
    h.mock.requests.length = 0;
    const r = await runSync({ ...h.deps, now: () => later }, job());
    expect(r).toMatchObject({ ok: true, mode: 'incremental' });
    const searches = h.mock.requests.filter((q) => q.path.endsWith('/rest/api/2/search'));
    expect(searches.length).toBeGreaterThan(0);
    for (const s of searches) {
      expect(new URLSearchParams(s.search).get('jql')).toMatch(
        /AND updated >= "-45m" ORDER BY created ASC$/,
      );
    }
    // Nothing was lost: membership is untouched by an incremental read.
    expect(await boardIssueCount('OPS Kanban')).toBe(31);
  });

  it('a full re-sync drops issues that left a board', async () => {
    const leaving = h.dataset.issues.find((i) => i.key === 'OPS-1');
    if (!leaving) throw new Error('fixture');
    leaving.filterIds = [];
    await h.rawDb
      .update(jiraSyncStates)
      .set({ lastFullSyncAt: new Date(NOW.getTime() - 25 * 3_600_000) });
    expect(await runSync(h.deps, job())).toMatchObject({ ok: true, mode: 'full' });
    expect(await boardIssueCount('OPS Kanban')).toBe(30);
    leaving.filterIds = [102];
  });

  it('records Jira failures on the sync state without throwing', async () => {
    const otherOrg = 'org_bad';
    const deps = {
      ...h.deps,
      testJira: async () => ({
        ok: true as const,
        deployment: 'datacenter' as const,
        version: '10',
        account: { id: 'x', displayName: 'X' },
      }),
    };
    const bad = await createJiraConnection(deps, owner(otherOrg), {
      name: 'Bad token',
      credentials: { kind: 'datacenter_pat', baseUrl: h.mock.url, token: 'revoked-pat' },
    });
    if (!bad.ok) throw new Error('setup');
    await discoverBoards(h.deps, owner(otherOrg), bad.connection.id); // fails (401), no boards
    expect(
      await runSync(h.deps, {
        orgId: otherOrg,
        connectionId: bad.connection.id,
        trigger: 'schedule',
      }),
    ).toEqual({ ok: false, code: 'no_boards' });
    // Give it a board row so the sync reaches Jira.
    await h.rawDb.insert(jiraBoards).values({
      orgId: otherOrg,
      connectionId: bad.connection.id,
      jiraBoardId: 1,
      name: 'DEMO',
      type: 'scrum',
      selected: true,
    });
    expect(
      await runSync(h.deps, {
        orgId: otherOrg,
        connectionId: bad.connection.id,
        trigger: 'schedule',
      }),
    ).toEqual({ ok: false, code: 'unauthorized' });
    const [state] = await h.rawDb
      .select()
      .from(jiraSyncStates)
      .where(eq(jiraSyncStates.connectionId, bad.connection.id));
    expect(state).toMatchObject({ status: 'error', lastError: 'unauthorized' });
  });

  it('runs one sync per connection at a time', async () => {
    const results = await Promise.all([runSync(h.deps, job()), runSync(h.deps, job())]);
    expect(results.map((r) => (r.ok ? 'ok' : r.code)).sort()).toEqual(['already_running', 'ok']);
  });

  it('re-checks the URL policy before every sync', async () => {
    expect(await runSync({ ...h.deps, allowedPrivateHosts: [] }, job())).toEqual({
      ok: false,
      code: 'blocked_url',
    });
  });

  it('is invisible to other workspaces', async () => {
    expect(await runSync(h.deps, { ...job(), orgId: 'org_z' })).toEqual({
      ok: false,
      code: 'not_found',
    });
    const [row] = await h.rawDb
      .select({ n: count() })
      .from(jiraSyncRuns)
      .where(and(eq(jiraSyncRuns.orgId, 'org_z')));
    expect(row?.n).toBe(0);
  });

  it('refreshes an expiring OAuth token before syncing a Cloud site', async () => {
    const cloud = await startMockJira({
      flavor: 'cloud',
      validAuthorization: 'Bearer access-2',
      pathPrefix: '/ex/jira/cloud-9',
      dataset: h.dataset,
      now: () => NOW,
    });
    try {
      const oauth: AtlassianOAuthClient = {
        createAuthorizationURL: () => new URL('https://auth.atlassian.com/authorize'),
        validateAuthorizationCode: async () => {
          throw new Error('unused');
        },
        refreshAccessToken: async () => ({
          accessToken: () => 'access-2',
          refreshToken: () => 'refresh-2',
          accessTokenExpiresAt: () => new Date(NOW.getTime() + 3_600_000),
        }),
      };
      const deps = { ...h.deps, oauth, atlassianApiBase: new URL(cloud.url).origin };
      const created = await createJiraConnection(
        {
          ...deps,
          testJira: async () => ({
            ok: true as const,
            deployment: 'cloud' as const,
            version: '1',
            account: { id: 'a', displayName: 'A' },
          }),
        },
        owner('org_cloud'),
        {
          name: 'Acme Cloud',
          credentials: {
            kind: 'cloud_oauth',
            baseUrl: 'https://acme.atlassian.net',
            cloudId: 'cloud-9',
            accessToken: 'access-1',
          },
          oauth: {
            refreshToken: 'refresh-1',
            expiresAt: new Date(Date.now() - 1000).toISOString(),
          },
          oauthGrantId: randomUUID(),
        },
      );
      if (!created.ok) throw new Error('setup');
      const found = await discoverBoards(deps, owner('org_cloud'), created.connection.id);
      expect(found.ok).toBe(true);
      const boards = await listBoards(deps, 'org_cloud', created.connection.id);
      await setBoardSelection(
        deps,
        owner('org_cloud'),
        created.connection.id,
        boards.map((b) => b.id),
      );
      expect(
        await runSync(deps, {
          orgId: 'org_cloud',
          connectionId: created.connection.id,
          trigger: 'manual',
        }),
      ).toMatchObject({ ok: true, issues: 56 });
      expect(
        await runSync(
          { ...deps, oauth: undefined },
          { orgId: 'org_cloud', connectionId: created.connection.id, trigger: 'manual' },
        ),
      ).toEqual({ ok: false, code: 'oauth_unavailable' });
    } finally {
      await cloud.close();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project sync src/run-sync.test.ts`
Expected: FAIL — `Cannot find module './run-sync'`.

- [ ] **Step 3: Implement**

`packages/sync/src/run-sync.ts`:
```ts
import { jiraBoards, jiraConnections, jiraSyncRuns, jiraSyncStates, withOrg } from '@agile/db';
import {
  buildIssueJql,
  completeHistories,
  errorStatus,
  findSprintField,
  issueFieldList,
  type JiraBoardConfig,
  type JiraDataSource,
  type JiraStatusInfo,
  type NormalizedIssue,
  normalizeIssue,
} from '@agile/jira';
import { and, eq, isNull, lt, ne, or } from 'drizzle-orm';
import { failureOf } from './boards';
import { openDataSource } from './credentials';
import { type SyncDeps, SyncError, type SyncFailure } from './deps';
import {
  ensureStatusMappings,
  pruneBoardIssues,
  saveBoardConfig,
  saveIssues,
  saveSprints,
} from './persist';

export interface SyncJob {
  orgId: string;
  connectionId: string;
  trigger: 'manual' | 'schedule';
}

export type SyncOutcome =
  | { ok: true; mode: 'full' | 'incremental'; boards: number; issues: number }
  | SyncFailure;

/** A full re-read (which also drops issues that left a board) at least this often. */
export const FULL_SYNC_EVERY_MS = 24 * 3_600_000;
/** A "running" lease older than this is considered abandoned (crashed worker). */
const LEASE_MS = 3_600_000;

/**
 * Syncs every selected board of one connection. First run (and once a day) reads everything;
 * otherwise only issues updated since the last successful sync started (minus an overlap).
 * Never throws for Jira/credential problems: the outcome and the stored sync state carry a code.
 */
export async function runSync(deps: SyncDeps, job: SyncJob): Promise<SyncOutcome> {
  const now = deps.now?.() ?? new Date();
  const lease = await withOrg(deps.db, job.orgId, async (tx) => {
    const [conn] = await tx
      .select({ id: jiraConnections.id })
      .from(jiraConnections)
      .where(eq(jiraConnections.id, job.connectionId));
    if (!conn) return null;
    await tx
      .insert(jiraSyncStates)
      .values({ orgId: job.orgId, connectionId: job.connectionId })
      .onConflictDoNothing();
    // Take the lease: only one sync per connection at a time.
    const [state] = await tx
      .update(jiraSyncStates)
      .set({ status: 'running', lastStartedAt: now })
      .where(
        and(
          eq(jiraSyncStates.connectionId, job.connectionId),
          or(
            ne(jiraSyncStates.status, 'running'),
            isNull(jiraSyncStates.lastStartedAt),
            lt(jiraSyncStates.lastStartedAt, new Date(now.getTime() - LEASE_MS)),
          ),
        ),
      )
      .returning();
    if (!state) return { state: null, runId: null, mode: 'full' as const };
    const mode: 'full' | 'incremental' =
      !state.watermark ||
      !state.lastFullSyncAt ||
      now.getTime() - state.lastFullSyncAt.getTime() >= FULL_SYNC_EVERY_MS
        ? 'full'
        : 'incremental';
    const [run] = await tx
      .insert(jiraSyncRuns)
      .values({
        orgId: job.orgId,
        connectionId: job.connectionId,
        trigger: job.trigger,
        mode,
        startedAt: now,
      })
      .returning({ id: jiraSyncRuns.id });
    return { state, runId: run?.id ?? null, mode };
  });
  if (!lease) return { ok: false, code: 'not_found' };
  if (!lease.state || !lease.runId) return { ok: false, code: 'already_running' };
  const { state, runId, mode } = lease;

  let boardsSynced = 0;
  let issuesSynced = 0;
  try {
    const boards = await withOrg(deps.db, job.orgId, (tx) =>
      tx
        .select()
        .from(jiraBoards)
        .where(and(eq(jiraBoards.connectionId, job.connectionId), eq(jiraBoards.selected, true))),
    );
    if (boards.length === 0) throw new SyncError('no_boards');
    const source = await openDataSource(deps, job.orgId, job.connectionId);
    const sprintFieldId = findSprintField(await source.listFields());
    const statuses = new Map((await source.listStatuses()).map((s) => [s.id, s]));
    for (const board of boards) {
      const count = await syncBoard(deps, source, {
        orgId: job.orgId,
        connectionId: job.connectionId,
        board,
        since: mode === 'full' ? null : state.watermark,
        now,
        mode,
        sprintFieldId,
        statuses,
      });
      if (count === null) continue;
      boardsSynced++;
      issuesSynced += count;
    }
    await withOrg(deps.db, job.orgId, async (tx) => {
      const finished = new Date();
      await tx
        .update(jiraSyncStates)
        .set({
          status: 'ok',
          watermark: now,
          lastFullSyncAt: mode === 'full' ? now : state.lastFullSyncAt,
          lastFinishedAt: finished,
          lastSuccessAt: finished,
          lastError: null,
        })
        .where(eq(jiraSyncStates.connectionId, job.connectionId));
      await tx
        .update(jiraSyncRuns)
        .set({ status: 'ok', finishedAt: finished, boardsSynced, issuesUpserted: issuesSynced })
        .where(eq(jiraSyncRuns.id, runId));
    });
    return { ok: true, mode, boards: boardsSynced, issues: issuesSynced };
  } catch (e) {
    const failure = failureOf(deps, e);
    await withOrg(deps.db, job.orgId, async (tx) => {
      const finished = new Date();
      await tx
        .update(jiraSyncStates)
        .set({ status: 'error', lastError: failure.code, lastFinishedAt: finished })
        .where(eq(jiraSyncStates.connectionId, job.connectionId));
      await tx
        .update(jiraSyncRuns)
        .set({
          status: 'error',
          error: failure.code,
          finishedAt: finished,
          boardsSynced,
          issuesUpserted: issuesSynced,
        })
        .where(eq(jiraSyncRuns.id, runId));
    });
    return failure;
  }
}

interface BoardJob {
  orgId: string;
  connectionId: string;
  board: typeof jiraBoards.$inferSelect;
  since: Date | null;
  now: Date;
  mode: 'full' | 'incremental';
  sprintFieldId: string | null;
  statuses: Map<string, JiraStatusInfo>;
}

/** Returns the number of issues read, or null when the board no longer exists in Jira. */
async function syncBoard(
  deps: SyncDeps,
  source: JiraDataSource,
  j: BoardJob,
): Promise<number | null> {
  let config: JiraBoardConfig;
  try {
    config = await source.getBoardConfig(j.board.jiraBoardId);
  } catch (e) {
    if (errorStatus(e) === 404) return null;
    throw e;
  }
  const sprints = j.board.type === 'scrum' ? await source.listSprints(j.board.jiraBoardId) : [];
  await withOrg(deps.db, j.orgId, async (tx) => {
    await saveBoardConfig(tx, j.board.id, config);
    await saveSprints(tx, j.orgId, j.connectionId, j.board.id, sprints);
    await ensureStatusMappings(
      tx,
      j.orgId,
      j.board.id,
      config.columns.flatMap((c) => c.statusIds),
      j.statuses,
    );
  });
  if (config.filterId === null) return 0;

  const ctx = {
    estimationFieldId: config.estimationFieldId,
    estimationFieldName: config.estimationFieldName,
    sprintFieldId: j.sprintFieldId,
  };
  const seen: string[] = [];
  const statusIds = new Set<string>();
  for await (const page of source.searchIssues(
    buildIssueJql(config.filterId, j.since, j.now),
    issueFieldList(ctx),
  )) {
    const issues: NormalizedIssue[] = [];
    for (const raw of page) {
      const issue = normalizeIssue(raw, await completeHistories(source, raw), ctx);
      issues.push(issue);
      statusIds.add(issue.statusId);
      for (const t of issue.transitions) {
        statusIds.add(t.toStatusId);
        if (t.fromStatusId) statusIds.add(t.fromStatusId);
      }
    }
    seen.push(
      ...(await withOrg(deps.db, j.orgId, (tx) =>
        saveIssues(tx, j.orgId, j.connectionId, j.board.id, issues),
      )),
    );
  }
  await withOrg(deps.db, j.orgId, async (tx) => {
    await ensureStatusMappings(tx, j.orgId, j.board.id, statusIds, j.statuses);
    if (j.mode === 'full') await pruneBoardIssues(tx, j.board.id, seen);
    await tx.update(jiraBoards).set({ lastSyncedAt: j.now }).where(eq(jiraBoards.id, j.board.id));
  });
  return seen.length;
}
```

`packages/sync/src/index.ts`:
```ts
export {
  type BoardView,
  discoverBoards,
  getBoard,
  getSyncState,
  listBoards,
  listSelectedBoards,
  listStatusMappings,
  type StatusMappingView,
  type SyncStateView,
  saveStatusMappings,
  setBoardSelection,
} from './boards';
export { resolveCredentials } from './credentials';
export { type SyncDeps, SyncError, type SyncFailure, type SyncFailureCode } from './deps';
export { FULL_SYNC_EVERY_MS, runSync, type SyncJob, type SyncOutcome } from './run-sync';
```

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `pnpm vitest run --project sync && pnpm lint && pnpm typecheck`
Expected: PASS — 15 tests. The first sync reads 56 issues (25 + 31), 4 sprints, and DEMO-6 (carried out of sprint 1) belongs to sprints 1 and 2; the incremental run sends `updated >= "-45m"` (30 minutes since the watermark + 15); a concurrent pair yields one `already_running`; the Cloud OAuth case refreshes the expired token (the mock only accepts the refreshed one).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(sync): incremental Jira sync with a lease, daily full re-read and stored outcomes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `@agile/sync` — pg-boss queue: "Sync now", scheduled tick, workers

**Files:**
- Create: `packages/sync/src/queue.ts`
- Modify: `packages/sync/src/index.ts`
- Test: `packages/sync/src/queue.test.ts`

**Interfaces:**
- `SYNC_QUEUE = 'jira-sync'`, `SYNC_TICK_QUEUE = 'jira-sync-tick'`.
- `startSyncQueue(connectionString, { role: 'producer' | 'worker'; onError? }): Promise<PgBoss>` — `new PgBoss({ connectionString, createSchema: false, max, …(producer ? { supervise: false, schedule: false } : {}) })`, an `'error'` listener (an unhandled `error` event would crash the process), `start()`, then `createQueue(SYNC_QUEUE, { policy: 'exclusive', retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 3600 })` and `createQueue(SYNC_TICK_QUEUE, { policy: 'exclusive', retryLimit: 0, expireInSeconds: 300 })` (idempotent).
- `requestSync({ db, boss }, actor, connectionId): Promise<{ ok: true; queued: boolean } | { ok: false; code: 'not_found' | 'no_boards' }>` — owner/admin; marks the state `queued` (a running sync stays `running`), audits `jira_sync.requested`, sends `{ orgId, connectionId, trigger: 'manual' }` with `singletonKey: connectionId`; `queued: false` when one is already queued or running.
- `enqueueScheduledSyncs({ db, boss }): Promise<number>` — every organisation (better-auth `organization` table, no RLS) × every connection with selected boards → a `schedule` job.
- `cronEvery(minutes)` → `*/N * * * *` (`0 * * * *` for 60).
- `startSyncWorker(boss, deps, { intervalMinutes; concurrency?: 2; onOutcome? })` — `work(SYNC_QUEUE, { batchSize: 1, localConcurrency }, async ([job]) => runSync(deps, job.data))`, `work(SYNC_TICK_QUEUE, …enqueueScheduledSyncs)`, `schedule(SYNC_TICK_QUEUE, cronEvery(intervalMinutes), null, { tz: 'UTC' })`.

**Verified pg-boss 12.36.0 behaviour (scratch run against Postgres 17 as a non-owner role):** with `createSchema: false` and a pre-created schema owned by that role, `start()` installs pg-boss (schema version 44); `createQueue` is idempotent; `work()` handlers receive an **array** of jobs; with `policy: 'exclusive'` a second `send` with the same `singletonKey` returns `null` while the first is queued or active; a producer started with `{ migrate: false }` on a missing schema throws `pg-boss is not installed`; `send` to a queue that was never created throws `Queue … does not exist`.

- [ ] **Step 1: Write the failing tests**

`packages/sync/src/queue.test.ts`:
```ts
import { jiraSyncStates, organization } from '@agile/db';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverBoards, getSyncState, listBoards, setBoardSelection } from './boards';
import {
  cronEvery,
  enqueueScheduledSyncs,
  requestSync,
  SYNC_QUEUE,
  SYNC_TICK_QUEUE,
  startSyncQueue,
  startSyncWorker,
} from './queue';
import { member, owner, startSyncHarness } from './test-harness';

async function waitFor<T>(
  read: () => Promise<T>,
  done: (v: T) => boolean,
  ms = 30_000,
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > until) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('sync queue (pg-boss, as app_user)', () => {
  let h: Awaited<ReturnType<typeof startSyncHarness>>;
  let producer: PgBoss;
  let connectionId = '';

  beforeAll(async () => {
    h = await startSyncHarness();
    producer = await startSyncQueue(h.tdb.appUrl, { role: 'producer' });
    connectionId = await h.connect();
    await discoverBoards(h.deps, owner(), connectionId);
  });
  afterAll(async () => {
    await producer?.stop({ graceful: false });
    await h?.stop();
  });

  it('needs selected boards before queueing', async () => {
    expect(await requestSync({ db: h.db, boss: producer }, owner(), connectionId)).toEqual({
      ok: false,
      code: 'no_boards',
    });
    await expect(
      requestSync({ db: h.db, boss: producer }, member(), connectionId),
    ).rejects.toThrow();
    expect(await requestSync({ db: h.db, boss: producer }, owner('org_b'), connectionId)).toEqual({
      ok: false,
      code: 'not_found',
    });
  });

  it('queues one sync per connection, then a worker runs it', async () => {
    const boards = await listBoards(h.deps, 'org_a', connectionId);
    await setBoardSelection(
      h.deps,
      owner(),
      connectionId,
      boards.map((b) => b.id),
    );
    expect(await requestSync({ db: h.db, boss: producer }, owner(), connectionId)).toEqual({
      ok: true,
      queued: true,
    });
    expect(await requestSync({ db: h.db, boss: producer }, owner(), connectionId)).toEqual({
      ok: true,
      queued: false,
    });
    expect((await getSyncState(h.deps, 'org_a', connectionId)).status).toBe('queued');

    const worker = await startSyncQueue(h.tdb.appUrl, { role: 'worker' });
    try {
      await startSyncWorker(worker, h.deps, { intervalMinutes: 15 });
      const state = await waitFor(
        () => getSyncState(h.deps, 'org_a', connectionId),
        (s) => s.status === 'ok' || s.status === 'error',
      );
      expect(state).toMatchObject({ status: 'ok', lastError: null });
      const schedules = await worker.getSchedules();
      expect(schedules.map((s) => [s.name, s.cron, s.timezone])).toEqual([
        [SYNC_TICK_QUEUE, '*/15 * * * *', 'UTC'],
      ]);
    } finally {
      await worker.stop({ graceful: false });
    }
  });

  it('the scheduled tick queues every connection with selected boards', async () => {
    const other = await h.connect(owner('org_b'), 'B');
    await discoverBoards(h.deps, owner('org_b'), other); // nothing selected in org_b
    await h.rawDb.update(jiraSyncStates).set({ status: 'ok' });
    // org_a has one connection with selected boards; org_b has none. Organisations come from better-auth.
    await h.rawDb.insert(organization).values([
      { id: 'org_a', name: 'A', slug: 'a', createdAt: new Date() },
      { id: 'org_b', name: 'B', slug: 'b', createdAt: new Date() },
    ]);
    expect(await enqueueScheduledSyncs({ db: h.db, boss: producer })).toBe(1);
    expect(await enqueueScheduledSyncs({ db: h.db, boss: producer })).toBe(0); // already queued
    await producer.deleteQueuedJobs(SYNC_QUEUE);
  });

  it('builds cron expressions for supported intervals', () => {
    expect(cronEvery(5)).toBe('*/5 * * * *');
    expect(cronEvery(60)).toBe('0 * * * *');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --project sync src/queue.test.ts`
Expected: FAIL — `Cannot find module './queue'`.

- [ ] **Step 3: Implement**

`packages/sync/src/queue.ts`:
```ts
import { type Actor, assertCanManage, recordAudit } from '@agile/connections';
import {
  type Db,
  jiraBoards,
  jiraConnections,
  jiraSyncStates,
  organization,
  withOrg,
} from '@agile/db';
import { and, eq, sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import type { SyncDeps } from './deps';
import { runSync, type SyncJob, type SyncOutcome } from './run-sync';

export const SYNC_QUEUE = 'jira-sync';
export const SYNC_TICK_QUEUE = 'jira-sync-tick';

/**
 * Starts pg-boss as the app role in the `pgboss` schema (created by our migrations; pg-boss
 * installs and upgrades its own tables there) and makes sure both queues exist.
 * Producers (the web app) only send jobs: no maintenance, no cron.
 */
export async function startSyncQueue(
  connectionString: string,
  opts: { role: 'producer' | 'worker'; onError?: (error: Error) => void },
): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString,
    createSchema: false,
    max: opts.role === 'worker' ? 4 : 2,
    ...(opts.role === 'producer' ? { supervise: false, schedule: false } : {}),
  });
  // pg-boss emits 'error' for background failures; an unhandled 'error' event would crash the process.
  boss.on('error', opts.onError ?? (() => {}));
  await boss.start();
  // One queued-or-active sync per connection (singletonKey = connection id).
  await boss.createQueue(SYNC_QUEUE, {
    policy: 'exclusive',
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 3600,
  });
  await boss.createQueue(SYNC_TICK_QUEUE, {
    policy: 'exclusive',
    retryLimit: 0,
    expireInSeconds: 300,
  });
  return boss;
}

const send = (boss: PgBoss, job: SyncJob) =>
  boss.send(SYNC_QUEUE, { ...job }, { singletonKey: job.connectionId });

/** "Sync now": queues a sync unless one is already queued or running. */
export async function requestSync(
  deps: { db: Db; boss: PgBoss },
  actor: Actor,
  connectionId: string,
): Promise<{ ok: true; queued: boolean } | { ok: false; code: 'not_found' | 'no_boards' }> {
  assertCanManage(actor);
  const check = await withOrg(deps.db, actor.orgId, async (tx) => {
    const [conn] = await tx
      .select({ id: jiraConnections.id })
      .from(jiraConnections)
      .where(eq(jiraConnections.id, connectionId));
    if (!conn) return 'not_found' as const;
    const [board] = await tx
      .select({ id: jiraBoards.id })
      .from(jiraBoards)
      .where(and(eq(jiraBoards.connectionId, connectionId), eq(jiraBoards.selected, true)))
      .limit(1);
    if (!board) return 'no_boards' as const;
    await tx
      .insert(jiraSyncStates)
      .values({ orgId: actor.orgId, connectionId, status: 'queued' })
      .onConflictDoUpdate({
        target: jiraSyncStates.connectionId,
        // A running sync keeps showing as running.
        set: {
          status: sql`case when ${jiraSyncStates.status} = 'running' then 'running'::sync_status else 'queued'::sync_status end`,
        },
      });
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'jira_sync.requested',
      targetType: 'jira_connection',
      targetId: connectionId,
    });
    return 'ok' as const;
  });
  if (check !== 'ok') return { ok: false, code: check };
  const id = await send(deps.boss, { orgId: actor.orgId, connectionId, trigger: 'manual' });
  return { ok: true, queued: id !== null };
}

/** Scheduled tick: queue a sync for every connection that has selected boards, in every workspace. */
export async function enqueueScheduledSyncs(deps: { db: Db; boss: PgBoss }): Promise<number> {
  // `organization` (better-auth) has no org_id column and no RLS: it is the list of tenants.
  const orgs = await deps.db.select({ id: organization.id }).from(organization);
  let sent = 0;
  for (const { id: orgId } of orgs) {
    const connections = await withOrg(deps.db, orgId, (tx) =>
      tx
        .selectDistinct({ connectionId: jiraBoards.connectionId })
        .from(jiraBoards)
        .where(eq(jiraBoards.selected, true)),
    );
    for (const { connectionId } of connections) {
      if (await send(deps.boss, { orgId, connectionId, trigger: 'schedule' })) sent++;
    }
  }
  return sent;
}

/** Cron expression for "every N minutes" (N divides 60). */
export const cronEvery = (minutes: number) =>
  minutes >= 60 ? '0 * * * *' : `*/${minutes} * * * *`;

/** Registers the sync workers and the recurring tick on a worker-role queue. */
export async function startSyncWorker(
  boss: PgBoss,
  deps: SyncDeps,
  opts: {
    intervalMinutes: number;
    concurrency?: number;
    onOutcome?: (job: SyncJob, outcome: SyncOutcome) => void;
  },
): Promise<void> {
  await boss.work<SyncJob>(
    SYNC_QUEUE,
    { batchSize: 1, localConcurrency: opts.concurrency ?? 2 },
    async ([job]) => {
      if (!job) return;
      const outcome = await runSync(deps, job.data);
      opts.onOutcome?.(job.data, outcome);
      return outcome;
    },
  );
  await boss.work(SYNC_TICK_QUEUE, async () => {
    await enqueueScheduledSyncs({ db: deps.db, boss });
  });
  await boss.schedule(SYNC_TICK_QUEUE, cronEvery(opts.intervalMinutes), null, { tz: 'UTC' });
}
```

`packages/sync/src/index.ts`:
```ts
export {
  type BoardView,
  discoverBoards,
  getBoard,
  getSyncState,
  listBoards,
  listSelectedBoards,
  listStatusMappings,
  type StatusMappingView,
  type SyncStateView,
  saveStatusMappings,
  setBoardSelection,
} from './boards';
export { resolveCredentials } from './credentials';
export { type SyncDeps, SyncError, type SyncFailure, type SyncFailureCode } from './deps';
export {
  cronEvery,
  enqueueScheduledSyncs,
  requestSync,
  SYNC_QUEUE,
  SYNC_TICK_QUEUE,
  startSyncQueue,
  startSyncWorker,
} from './queue';
export { FULL_SYNC_EVERY_MS, runSync, type SyncJob, type SyncOutcome } from './run-sync';
```

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `pnpm vitest run --project sync && pnpm lint && pnpm typecheck`
Expected: PASS — 19 tests (the queue test runs pg-boss as `app_user` against the migrated test database and waits for a real worker to finish the sync).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(sync): pg-boss queue for Sync now and scheduled syncs, one per connection

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: `apps/worker` — the sync worker process (env, health, image)

**Files:**
- Create: `packages/config/src/worker-env.ts`, `apps/worker/{package.json,tsconfig.json,vitest.config.ts}`, `apps/worker/src/{log,health,worker,main}.ts`
- Modify: `packages/config/src/index.ts`, root `vitest.config.ts` (add `apps/worker`), `apps/web/Dockerfile` (worker image)
- Test: `packages/config/src/worker-env.test.ts`, `apps/worker/src/worker.test.ts`

**Interfaces:**
- `parseWorkerEnv(source?): WorkerEnv` = the server env (same `.env` as the web app) + `SYNC_INTERVAL_MINUTES` (5/10/15/20/30/60, default 15) + `WORKER_HEALTH_PORT` (default 8080); empty strings count as unset; errors never echo values.
- `startWorker(env, log): Promise<{ healthPort; stop() }>` — db pool (5), Atlassian OAuth client when configured, `SyncDeps` whose `onError` logs `{ code, error: e.name }`, `startSyncQueue(role: 'worker')`, `startSyncWorker` (logs every outcome), `GET /health` → 200 `{ status: 'ok' }` when `select 1` works (503 otherwise); `stop()` closes health, `boss.stop({ graceful: true, timeout: 30_000 })`, closes the pool.
- `main.ts` handles SIGTERM/SIGINT once. Log lines are JSON with codes and names only.
- Scripts: `pnpm --filter @agile/worker start` (`tsx --env-file-if-exists=../../.env src/main.ts`), `dev` (watch). Root `pnpm dev` (turbo) now runs web and worker.
- Image: `apps/web/Dockerfile` target `worker` — `pnpm --filter @agile/worker deploy --prod --legacy /out` (pnpm 10 needs `--legacy` without injected workspace packages), run with `node --import tsx src/main.ts`, port 8080, user `app`.

**Ruling — run TypeScript with tsx in production.** Workspace packages ship TypeScript source (Phase 1 convention, Next transpiles them for the web app). The worker reuses them through tsx instead of adding a bundler. Verified: the deployed folder starts with `node --import tsx` (tsx transforms the TS inside `node_modules/@agile/*`), the image builds and answers `/health`. Cost if wrong: ~1 s slower start and a ~220 MB deploy; a bundling step can replace it later without code changes.

- [ ] **Step 1: Write the failing tests**

`packages/config/src/worker-env.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { EnvError } from './env';
import { parseWorkerEnv } from './worker-env';

const valid = {
  DATABASE_URL: 'postgres://app_user:pw@localhost:5432/agile',
  BETTER_AUTH_SECRET: 's'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3000',
  ENCRYPTION_KEYS: `v1:${Buffer.alloc(32, 1).toString('base64')}`,
};

describe('parseWorkerEnv', () => {
  it('adds worker defaults to the server environment', () => {
    expect(parseWorkerEnv(valid)).toMatchObject({
      DATABASE_URL: valid.DATABASE_URL,
      SYNC_INTERVAL_MINUTES: 15,
      WORKER_HEALTH_PORT: 8080,
    });
  });

  it('treats empty values as unset and reads numbers', () => {
    expect(
      parseWorkerEnv({ ...valid, SYNC_INTERVAL_MINUTES: '', WORKER_HEALTH_PORT: '4030' }),
    ).toMatchObject({ SYNC_INTERVAL_MINUTES: 15, WORKER_HEALTH_PORT: 4030 });
  });

  it('rejects intervals that do not divide an hour', () => {
    expect(() => parseWorkerEnv({ ...valid, SYNC_INTERVAL_MINUTES: '7' })).toThrow(EnvError);
    expect(() => parseWorkerEnv({ ...valid, SYNC_INTERVAL_MINUTES: '7' })).toThrow(
      /SYNC_INTERVAL_MINUTES/,
    );
  });

  it('still validates the shared server settings', () => {
    expect(() => parseWorkerEnv({ ...valid, ENCRYPTION_KEYS: undefined })).toThrow(
      /ENCRYPTION_KEYS/,
    );
  });
});
```

`apps/worker/src/worker.test.ts`:
```ts
import { parseWorkerEnv } from '@agile/config';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import { SYNC_TICK_QUEUE, startSyncQueue } from '@agile/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from './log';
import { type RunningWorker, startWorker } from './worker';

describe('worker', () => {
  let tdb: TestDatabase;
  let worker: RunningWorker | undefined;
  const events: string[] = [];
  const log: Logger = (_level, event) => void events.push(event);

  beforeAll(async () => {
    tdb = await startTestDatabase();
  });
  afterAll(async () => {
    await worker?.stop();
    await tdb?.stop();
  });

  it('starts, schedules the sync tick, answers health checks and stops cleanly', async () => {
    const env = parseWorkerEnv({
      DATABASE_URL: tdb.appUrl,
      BETTER_AUTH_SECRET: 's'.repeat(32),
      BETTER_AUTH_URL: 'http://localhost:3000',
      ENCRYPTION_KEYS: `v1:${Buffer.alloc(32, 3).toString('base64')}`,
      SYNC_INTERVAL_MINUTES: '30',
    });
    worker = await startWorker({ ...env, WORKER_HEALTH_PORT: 0 }, log);
    expect(events).toContain('worker_started');

    const res = await fetch(`http://127.0.0.1:${worker.healthPort}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect((await fetch(`http://127.0.0.1:${worker.healthPort}/other`)).status).toBe(404);

    const probe = await startSyncQueue(tdb.appUrl, { role: 'producer' });
    try {
      expect((await probe.getSchedules()).map((s) => [s.name, s.cron])).toEqual([
        [SYNC_TICK_QUEUE, '*/30 * * * *'],
      ]);
    } finally {
      await probe.stop({ graceful: false });
    }

    const port = worker.healthPort;
    await worker.stop();
    worker = undefined;
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});
```

`apps/worker/package.json`:
```json
{
  "name": "@agile/worker",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx --env-file-if-exists=../../.env src/main.ts",
    "dev": "tsx watch --env-file-if-exists=../../.env src/main.ts",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@agile/config": "workspace:*",
    "@agile/crypto": "workspace:*",
    "@agile/db": "workspace:*",
    "@agile/jira": "workspace:*",
    "@agile/sync": "workspace:*",
    "drizzle-orm": "0.45.3",
    "tsx": "4.23.15"
  },
  "devDependencies": {
    "@testcontainers/postgresql": "12.2.0"
  }
}
```

`apps/worker/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

`apps/worker/vitest.config.ts`:
```ts
import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'worker',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
```

Root `vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/web', 'apps/worker'],
  },
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm install && pnpm vitest run --project config --project worker`
Expected: FAIL — `Cannot find module './worker-env'` and `'./worker'`.

- [ ] **Step 3: Implement**

`packages/config/src/worker-env.ts`:
```ts
import { z } from 'zod';
import { EnvError, parseServerEnv, type ServerEnv } from './env';

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

const workerExtrasSchema = z.object({
  /** Minutes between scheduled syncs; must divide an hour so the cron schedule stays regular. */
  SYNC_INTERVAL_MINUTES: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number()
      .int()
      .refine((n) => [5, 10, 15, 20, 30, 60].includes(n), 'must be 5, 10, 15, 20, 30 or 60')
      .default(15),
  ),
  /** Port of the worker's /health endpoint. */
  WORKER_HEALTH_PORT: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(65_535).default(8080),
  ),
});

export type WorkerEnv = ServerEnv & z.infer<typeof workerExtrasSchema>;

/** The server environment (same .env as the web app) plus the worker's own settings. */
export function parseWorkerEnv(
  source: Record<string, string | undefined> = process.env,
): WorkerEnv {
  const server = parseServerEnv(source);
  const extras = workerExtrasSchema.safeParse(source);
  if (!extras.success) {
    const lines = extras.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`);
    throw new EnvError(`Invalid worker environment:\n${lines.join('\n')}`);
  }
  return { ...server, ...extras.data };
}
```

`packages/config/src/index.ts`:
```ts
export { EnvError, parseServerEnv, type ServerEnv, serverEnv, serverEnvSchema } from './env';
export { parseWorkerEnv, type WorkerEnv } from './worker-env';
```

`apps/worker/src/log.ts`:
```ts
export type Logger = (
  level: 'info' | 'warn' | 'error',
  event: string,
  fields?: Record<string, string | number | boolean | null>,
) => void;

/** One JSON object per line on stdout/stderr. Only codes and names: never messages or secrets. */
export const log: Logger = (level, event, fields = {}) => {
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
  if (level === 'info') console.log(line);
  else console.error(line);
};
```

`apps/worker/src/health.ts`:
```ts
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** GET /health → 200 when `check` passes, 503 otherwise (for Docker/Kubernetes probes and e2e). */
export async function startHealthServer(
  port: number,
  check: () => Promise<boolean>,
): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer(async (req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    const ok = await check().catch(() => false);
    res
      .writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
      .end(JSON.stringify({ status: ok ? 'ok' : 'unavailable' }));
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
```

`apps/worker/src/worker.ts`:
```ts
import type { WorkerEnv } from '@agile/config';
import { parseKeyring } from '@agile/crypto';
import { createDb } from '@agile/db';
import { createAtlassianOAuth } from '@agile/jira';
import { type SyncDeps, startSyncQueue, startSyncWorker } from '@agile/sync';
import { sql } from 'drizzle-orm';
import { startHealthServer } from './health';
import type { Logger } from './log';

export interface RunningWorker {
  healthPort: number;
  stop(): Promise<void>;
}

/** Wires the sync workers (pg-boss) and the health endpoint. */
export async function startWorker(env: WorkerEnv, log: Logger): Promise<RunningWorker> {
  const { db, close } = createDb(env.DATABASE_URL, { max: 5 });
  const oauth =
    env.ATLASSIAN_OAUTH_CLIENT_ID && env.ATLASSIAN_OAUTH_CLIENT_SECRET
      ? createAtlassianOAuth({
          clientId: env.ATLASSIAN_OAUTH_CLIENT_ID,
          clientSecret: env.ATLASSIAN_OAUTH_CLIENT_SECRET,
          redirectUri: new URL('/api/jira/oauth/callback', env.BETTER_AUTH_URL).toString(),
        })
      : undefined;
  const deps: SyncDeps = {
    db,
    keyring: parseKeyring(env.ENCRYPTION_KEYS),
    allowedPrivateHosts: env.ALLOWED_PRIVATE_HOSTS,
    oauth,
    onError: (error, code) =>
      log('warn', 'sync_error', { code, error: error instanceof Error ? error.name : 'unknown' }),
  };
  const boss = await startSyncQueue(env.DATABASE_URL, {
    role: 'worker',
    onError: (error) => log('error', 'queue_error', { error: error.name }),
  });
  await startSyncWorker(boss, deps, {
    intervalMinutes: env.SYNC_INTERVAL_MINUTES,
    onOutcome: (job, outcome) =>
      log(outcome.ok ? 'info' : 'warn', 'sync_finished', {
        orgId: job.orgId,
        connectionId: job.connectionId,
        trigger: job.trigger,
        ...(outcome.ok
          ? { mode: outcome.mode, boards: outcome.boards, issues: outcome.issues }
          : { code: outcome.code }),
      }),
  });
  const health = await startHealthServer(env.WORKER_HEALTH_PORT, async () => {
    await db.execute(sql`select 1`);
    return true;
  });
  log('info', 'worker_started', {
    healthPort: health.port,
    syncIntervalMinutes: env.SYNC_INTERVAL_MINUTES,
    oauth: Boolean(oauth),
  });
  return {
    healthPort: health.port,
    stop: async () => {
      await health.close();
      // Lets running syncs finish (up to 30 s), then closes pg-boss's pool.
      await boss.stop({ graceful: true, timeout: 30_000 });
      await close();
    },
  };
}
```

`apps/worker/src/main.ts`:
```ts
import { parseWorkerEnv } from '@agile/config';
import { log } from './log';
import { startWorker } from './worker';

const worker = await startWorker(parseWorkerEnv(), log);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log('info', 'worker_stopping', { signal });
  try {
    await worker.stop();
    process.exit(0);
  } catch (e) {
    log('error', 'worker_stop_failed', { error: e instanceof Error ? e.name : 'unknown' });
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
```

`apps/web/Dockerfile` (the deps stage needs the worker's manifest for `--frozen-lockfile`; new `worker-build` and `worker` stages):
```diff
diff --git a/apps/web/Dockerfile b/apps/web/Dockerfile
--- a/apps/web/Dockerfile
+++ b/apps/web/Dockerfile
@@ -8,6 +8,7 @@ WORKDIR /repo
 FROM base AS deps
 COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
 COPY apps/web/package.json apps/web/
+COPY apps/worker/package.json apps/worker/
 COPY e2e/package.json e2e/
 COPY packages/ packages/
 RUN find packages -type f ! -name package.json -delete
@@ -21,6 +22,20 @@ FROM base AS migrate
 COPY --from=build /repo /repo
 CMD ["pnpm", "db:migrate"]
 
+# The worker ships TypeScript sources run by tsx; `pnpm deploy` copies it with production deps only.
+FROM deps AS worker-build
+COPY . .
+RUN pnpm --filter @agile/worker deploy --prod --legacy /out
+
+FROM node:24-alpine AS worker
+ENV NODE_ENV=production
+WORKDIR /app
+RUN addgroup -S app && adduser -S app -G app
+COPY --from=worker-build --chown=app:app /out ./
+USER app
+EXPOSE 8080
+CMD ["node", "--import", "tsx", "src/main.ts"]
+
 FROM node:24-alpine AS runner
 ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
 WORKDIR /app
```

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `pnpm vitest run --project config --project worker && pnpm lint && pnpm typecheck`
Expected: PASS — config 9 tests, worker 1 test (starts the worker on a free port, `/health` 200, the tick schedule `*/30 * * * *` registered, stops cleanly).

- [ ] **Step 5: Smoke-run the worker and the image**

Run (dev Postgres on 5433, migrated):
```bash
WORKER_HEALTH_PORT=4031 pnpm --filter @agile/worker start &
sleep 8 && curl -s http://127.0.0.1:4031/health && kill %1
docker build -f apps/web/Dockerfile --target worker -t agile-worker:dev .
```
Expected: a `worker_started` JSON log line, `{"status":"ok"}`, then `worker_stopping`; the image builds.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(worker): sync worker process with health endpoint and container image

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Part 3 — Dashboards and UI

### Task 11: `@agile/dashboards` — widget catalog, default layouts, persistence, dataset loader

**Files:**
- Create: `packages/dashboards/{package.json,tsconfig.json,vitest.config.ts}`, `packages/dashboards/src/{widget-spec,widget-data,compute,layouts,dataset,store,index}.ts`
- Test: `packages/dashboards/src/{widget-spec,dataset,demo-dashboards}.test.ts`

**Interfaces:**
- `widgetSpecSchema` — zod discriminated union on `metric` (19 metrics): `{ id: string(1..64); metric; chart (allowed charts per metric); title?: string(1..80); params (per-metric object, defaults applied via .prefault({})) }`. Unknown keys are stripped. Types `WidgetSpec`, `WidgetSpecInput`, `MetricKey`; `METRIC_KEYS`; `parseWidgets(value): WidgetSpec[]` (drops stored widgets that no longer validate).
- Catalog (metric → charts → params): `average_velocity` kpi, `say_do_ratio` kpi, `velocity` bar `{ sprints: 6, unit }`; `scope_change` kpi, `sprint_burndown` line, `sprint_burnup` line `{ sprint: 'current' | 'last_closed', unit }`; `carry_over` kpi; `cycle_time`, `lead_time` kpi|table `{ windowDays: 90, percentile: 50|85|95 }`; `throughput` bar `{ weeks: 12 }`; `throughput_rate` kpi `{ days: 28 }`; `wip` kpi; `wip_trend` line `{ days: 30 }`; `aging_wip` table `{ windowDays }`; `cfd` area `{ days: 30 }`; `flow_efficiency` kpi `{ windowDays }`; `forecast_how_many` table `{ days: 14, historyDays: 30 }`; `forecast_when` table `{ items: 10, historyDays: 30 }`; `hygiene` table `{ staleDays: 14, oversizedPoints: 13 }`.
- `WidgetData = { kind: 'kpi'; value; format: 'number' | 'percent' | 'days' | 'points' | 'issues' | 'per_week'; hint? } | { kind: 'series'; chart: 'bar' | 'line' | 'area'; x; series: { key; stacked?; dashed? }[]; rows } | { kind: 'table'; columns: { key; type: 'text' | 'number' | 'days' | 'date' | 'code' | 'codes' }[]; rows } | { kind: 'empty'; reason: 'no_sprint' | 'no_data' | 'no_estimates' }`. Labels are message keys (`dashboards.series.*`, `columns.*`, `codes.*`, `hints.*`).
- `computeWidget(spec, dataset, now): WidgetData` — pure; `FORECAST_SEED = 42`; boards without an estimation field fall back from points to issue counts.
- `scrumLayout()`, `kanbanLayout()`, `defaultDashboards(boardType)` — Scrum boards get *Scrum* (KPIs: `avg-velocity`, `say-do`, `scope-added`, `carry-over`; charts: `velocity`, `burndown`, `burnup`, `hygiene`) and *Flow*; Kanban/simple boards get *Flow* (KPIs: `throughput-rate`, `cycle-time`, `wip`, `flow-efficiency`; `throughput`, `cfd`, `aging-wip`, `forecast-how-many`, `forecast-when`, `hygiene`). Widget ids are stable (`data-widget` in the UI).
- `loadBoardDataset(db, orgId, boardId): Promise<BoardDataset | null>` — one `withOrg` transaction, a handful of queries; sub-tasks excluded; `toMetricIssue(issue, transitions, changes, mappings)` (unmapped statuses count as to-do; consecutive statuses with the same mapping merge; flag/estimate history → intervals/changes).
- `ensureDefaultDashboards(db, orgId, userId, board)` (idempotent, race-safe through the partial unique index), `listDashboards(db, orgId, userId, boardId): DashboardView[]`, `saveDashboardWidgets(db, orgId, userId, dashboardId, widgets)` (validates every spec; max 40; for Phase 4's agent).

**Ruling — `title` is optional.** The spec's widget is `{ metric, params, chart, title }`. Default widgets have no stored title, so the UI shows the translated metric name in the viewer's language (EN/FR); a title is stored when a user/agent names a widget (Phase 4). Cost if wrong: Phase 4 must write titles in the user's language.

**Ruling — sub-tasks out, epics in.** Sub-tasks are excluded (Jira's sprint report and control chart count their parents). Epics are included only when a board's filter returns them as issues. Cost if wrong: Kanban boards whose filter includes epics see longer cycle times; a per-board exclusion setting would fix it.

- [ ] **Step 1: Package skeleton**

`packages/dashboards/package.json`:
```json
{
  "name": "@agile/dashboards",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@agile/db": "workspace:*",
    "@agile/metrics": "workspace:*",
    "drizzle-orm": "0.45.3",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@agile/sync": "workspace:*",
    "@testcontainers/postgresql": "12.2.0"
  }
}
```

`packages/dashboards/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

`packages/dashboards/vitest.config.ts`:
```ts
import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'dashboards',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
```

- [ ] **Step 2: Write the failing tests**

`packages/dashboards/src/widget-spec.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { kanbanLayout, scrumLayout } from './layouts';
import { METRIC_KEYS, parseWidgets, widgetSpecSchema } from './widget-spec';

describe('widget specs', () => {
  it('fills parameter defaults', () => {
    expect(widgetSpecSchema.parse({ id: 'v', metric: 'velocity', chart: 'bar' })).toEqual({
      id: 'v',
      metric: 'velocity',
      chart: 'bar',
      params: { sprints: 6, unit: 'points' },
    });
    expect(
      widgetSpecSchema.parse({
        id: 'c',
        metric: 'cycle_time',
        chart: 'table',
        params: { percentile: 95 },
      }),
    ).toMatchObject({ params: { windowDays: 90, percentile: 95 } });
  });

  it.each([
    ['an unknown metric', { id: 'x', metric: 'sql', chart: 'kpi' }],
    ['a chart the metric does not support', { id: 'x', metric: 'velocity', chart: 'kpi' }],
    [
      'an out-of-range parameter',
      { id: 'x', metric: 'velocity', chart: 'bar', params: { sprints: 1000 } },
    ],
    [
      'a percentile outside 50/85/95',
      { id: 'x', metric: 'cycle_time', chart: 'kpi', params: { percentile: 99 } },
    ],
    ['a missing id', { metric: 'wip', chart: 'kpi' }],
    ['an overlong title', { id: 'x', metric: 'wip', chart: 'kpi', title: 'x'.repeat(81) }],
  ])('rejects %s', (_case, input) => {
    expect(widgetSpecSchema.safeParse(input).success).toBe(false);
  });

  it('drops unknown keys instead of storing them', () => {
    const parsed = widgetSpecSchema.parse({
      id: 'w',
      metric: 'wip',
      chart: 'kpi',
      render: '<script>alert(1)</script>',
    });
    expect(parsed).toEqual({ id: 'w', metric: 'wip', chart: 'kpi', params: {} });
  });

  it('skips stored widgets that no longer validate', () => {
    expect(
      parseWidgets([{ id: 'a', metric: 'wip', chart: 'kpi' }, { id: 'b', metric: 'gone' }, 'junk']),
    ).toHaveLength(1);
    expect(parseWidgets(null)).toEqual([]);
  });

  it('default layouts are valid and use every metric of the catalog at most once', () => {
    const all = [...scrumLayout(), ...kanbanLayout()];
    expect(all.every((w) => widgetSpecSchema.safeParse(w).success)).toBe(true);
    for (const layout of [scrumLayout(), kanbanLayout()]) {
      expect(new Set(layout.map((w) => w.id)).size).toBe(layout.length);
    }
    expect(METRIC_KEYS).toHaveLength(19);
  });
});
```

`packages/dashboards/src/dataset.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { type StatusMapping, toMetricIssue } from './dataset';

const t = (iso: string) => new Date(iso);
const issue = {
  id: 'i1',
  orgId: 'o',
  connectionId: 'c',
  jiraIssueId: '1',
  key: 'A-1',
  summary: 'S',
  issueType: 'Story',
  isSubtask: false,
  statusId: '4',
  assigneeId: 'u-1',
  assigneeName: null,
  estimate: 5,
  jiraCreatedAt: t('2026-01-01T00:00:00Z'),
  jiraUpdatedAt: t('2026-01-09T00:00:00Z'),
  resolvedAt: null,
  syncedAt: t('2026-01-10T00:00:00Z'),
};
const mappings = new Map<string, StatusMapping>([
  ['1', { category: 'todo', blocked: false }],
  ['2', { category: 'in_progress', blocked: false }],
  ['3', { category: 'in_progress', blocked: true }],
  ['4', { category: 'done', blocked: false }],
]);

describe('toMetricIssue', () => {
  it('builds status periods from transitions, merging statuses with the same mapping', () => {
    const m = toMetricIssue(
      issue,
      [
        { at: t('2026-01-02T00:00:00Z'), fromStatusId: '1', toStatusId: '2' },
        { at: t('2026-01-03T00:00:00Z'), fromStatusId: '2', toStatusId: '9' }, // unmapped → to-do
        { at: t('2026-01-04T00:00:00Z'), fromStatusId: '9', toStatusId: '3' },
        { at: t('2026-01-05T00:00:00Z'), fromStatusId: '3', toStatusId: '2' },
        { at: t('2026-01-06T00:00:00Z'), fromStatusId: '2', toStatusId: '2' }, // no-op move
        { at: t('2026-01-07T00:00:00Z'), fromStatusId: '2', toStatusId: '4' },
      ],
      [],
      mappings,
    );
    expect(m.statusPeriods).toEqual([
      { from: t('2026-01-01T00:00:00Z'), category: 'todo', blocked: false },
      { from: t('2026-01-02T00:00:00Z'), category: 'in_progress', blocked: false },
      { from: t('2026-01-03T00:00:00Z'), category: 'todo', blocked: false },
      { from: t('2026-01-04T00:00:00Z'), category: 'in_progress', blocked: true },
      { from: t('2026-01-05T00:00:00Z'), category: 'in_progress', blocked: false },
      { from: t('2026-01-07T00:00:00Z'), category: 'done', blocked: false },
    ]);
    expect(m.assignee).toBe('u-1');
  });

  it('uses the current status when the issue never moved', () => {
    expect(toMetricIssue({ ...issue, statusId: '2' }, [], [], mappings).statusPeriods).toEqual([
      { from: t('2026-01-01T00:00:00Z'), category: 'in_progress', blocked: false },
    ]);
  });

  it('turns flag and estimate changes into intervals and estimate history', () => {
    const m = toMetricIssue(
      issue,
      [],
      [
        { at: t('2026-01-02T00:00:00Z'), kind: 'flag', fromValue: 'on', toValue: 'off' },
        { at: t('2026-01-03T00:00:00Z'), kind: 'estimate', fromValue: '3', toValue: '5' },
        { at: t('2026-01-04T00:00:00Z'), kind: 'flag', fromValue: 'off', toValue: 'on' },
      ],
      mappings,
    );
    expect(m.flagged).toEqual([
      { from: t('2026-01-01T00:00:00Z'), to: t('2026-01-02T00:00:00Z') },
      { from: t('2026-01-04T00:00:00Z'), to: null },
    ]);
    expect(m.estimateChanges).toEqual([{ at: t('2026-01-03T00:00:00Z'), from: 3, to: 5 }]);
  });
});
```

`packages/dashboards/src/demo-dashboards.test.ts` — the end-to-end check of the demo numbers (sync the demo board into Postgres, load it, compute the default layouts):
```ts
import { discoverBoards, listBoards, runSync, setBoardSelection } from '@agile/sync';
import { NOW, owner, startSyncHarness } from '@agile/sync/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeWidget } from './compute';
import { loadBoardDataset } from './dataset';
import { kanbanLayout, scrumLayout } from './layouts';
import { ensureDefaultDashboards, listDashboards, saveDashboardWidgets } from './store';
import type { WidgetData } from './widget-data';

// The demo dataset is what e2e and local review show; these are the numbers the e2e test checks.
describe('default dashboards on the synced demo data', () => {
  let h: Awaited<ReturnType<typeof startSyncHarness>>;
  let scrumId = '';
  let kanbanId = '';
  const kpis = (widgets: { id: string }[], data: WidgetData[]) =>
    Object.fromEntries(
      widgets.flatMap((w, i) => {
        const d = data[i];
        return d?.kind === 'kpi' ? [[w.id, d.value]] : [];
      }),
    );

  beforeAll(async () => {
    h = await startSyncHarness();
    const connectionId = await h.connect();
    await discoverBoards(h.deps, owner(), connectionId);
    const boards = await listBoards(h.deps, 'org_a', connectionId);
    await setBoardSelection(
      h.deps,
      owner(),
      connectionId,
      boards.map((b) => b.id),
    );
    await runSync(h.deps, { orgId: 'org_a', connectionId, trigger: 'manual' });
    scrumId = boards.find((b) => b.type === 'scrum')?.id ?? '';
    kanbanId = boards.find((b) => b.type === 'kanban')?.id ?? '';
  });
  afterAll(async () => h?.stop());

  it('Scrum KPIs: velocity 19, say/do 95%, 2 pts added, 1 carried over', async () => {
    const ds = await loadBoardDataset(h.db, 'org_a', scrumId);
    if (!ds) throw new Error('no dataset');
    const layout = scrumLayout();
    const data = layout.map((w) => computeWidget(w, ds, NOW));
    expect(kpis(layout, data)).toEqual({
      'avg-velocity': 19,
      'say-do': 0.95,
      'scope-added': 2,
      'carry-over': 1,
    });
    const velocity = data[layout.findIndex((w) => w.id === 'velocity')];
    expect(velocity).toMatchObject({
      kind: 'series',
      rows: [
        { sprint: 'DEMO Sprint 1', committed: 20, completed: 19 },
        { sprint: 'DEMO Sprint 2', committed: 20, completed: 19 },
        { sprint: 'DEMO Sprint 3', committed: 20, completed: 19 },
      ],
    });
    const burndown = data[layout.findIndex((w) => w.id === 'burndown')];
    expect(burndown?.kind === 'series' && burndown.rows[0]).toMatchObject({
      remaining: 20,
      ideal: 20,
    });
  });

  it('Flow KPIs: 3 per week, cycle time p85 8 days, WIP 4, flow efficiency 83%', async () => {
    const ds = await loadBoardDataset(h.db, 'org_a', kanbanId);
    if (!ds) throw new Error('no dataset');
    const layout = kanbanLayout();
    const data = layout.map((w) => computeWidget(w, ds, NOW));
    expect(kpis(layout, data)).toEqual({
      'throughput-rate': 3,
      'cycle-time': 8,
      wip: 4,
      'flow-efficiency': 0.8261,
    });
    for (const id of ['throughput', 'cfd', 'aging-wip', 'forecast-how-many', 'forecast-when']) {
      expect(data[layout.findIndex((w) => w.id === id)]?.kind).not.toBe('empty');
    }
  });

  it('creates default dashboards once per user and board', async () => {
    await Promise.all([
      ensureDefaultDashboards(h.db, 'org_a', 'user_1', { id: scrumId, type: 'scrum' }),
      ensureDefaultDashboards(h.db, 'org_a', 'user_1', { id: scrumId, type: 'scrum' }),
    ]);
    await ensureDefaultDashboards(h.db, 'org_a', 'user_1', { id: kanbanId, type: 'kanban' });
    expect((await listDashboards(h.db, 'org_a', 'user_1', scrumId)).map((d) => d.kind)).toEqual([
      'scrum',
      'kanban',
    ]);
    expect((await listDashboards(h.db, 'org_a', 'user_1', kanbanId)).map((d) => d.kind)).toEqual([
      'kanban',
    ]);
    expect(await listDashboards(h.db, 'org_a', 'user_2', scrumId)).toEqual([]);
    expect(await listDashboards(h.db, 'org_b', 'user_1', scrumId)).toEqual([]);
  });

  it('only stores valid widgets', async () => {
    const [dash] = await listDashboards(h.db, 'org_a', 'user_1', kanbanId);
    const id = dash?.id ?? '';
    expect(
      await saveDashboardWidgets(h.db, 'org_a', 'user_1', id, [{ id: 'x', metric: 'nope' }]),
    ).toEqual({
      ok: false,
      code: 'invalid_widget',
    });
    expect(
      await saveDashboardWidgets(h.db, 'org_a', 'user_2', id, [
        { id: 'w', metric: 'wip', chart: 'kpi' },
      ]),
    ).toEqual({ ok: false, code: 'not_found' });
    expect(
      await saveDashboardWidgets(h.db, 'org_a', 'user_1', id, [
        { id: 'w', metric: 'wip', chart: 'kpi' },
      ]),
    ).toEqual({ ok: true });
    expect((await listDashboards(h.db, 'org_a', 'user_1', kanbanId))[0]?.widgets).toEqual([
      { id: 'w', metric: 'wip', chart: 'kpi', params: {} },
    ]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm install && pnpm vitest run --project dashboards`
Expected: FAIL — `Cannot find module './layouts'`, `'./widget-spec'`, `'./dataset'`.

- [ ] **Step 4: Implement**

`packages/dashboards/src/widget-spec.ts`:
```ts
import { z } from 'zod';

// The fixed widget catalog. A widget is data, never code: { metric, params, chart, title }. Phase 4's
// agent creates widgets by emitting these specs, which are validated here before they are stored.

const unit = z.enum(['points', 'issues']).default('points');
const windowDays = z.number().int().min(7).max(365).default(90);
const sprintPick = z.enum(['current', 'last_closed']).default('current');
const percentile = z.union([z.literal(50), z.literal(85), z.literal(95)]).default(85);
const days = (fallback: number) => z.number().int().min(7).max(180).default(fallback);

// `.prefault({})`: a missing params object is parsed as {} so every field default applies.
const p = {
  sprints: z.object({ sprints: z.number().int().min(1).max(20).default(6), unit }).prefault({}),
  sprint: z.object({ sprint: sprintPick, unit }).prefault({}),
  none: z.object({}).prefault({}),
  percentile: z.object({ windowDays, percentile }).prefault({}),
  window: z.object({ windowDays }).prefault({}),
  weeks: z.object({ weeks: z.number().int().min(2).max(52).default(12) }).prefault({}),
  rate: z.object({ days: days(28) }).prefault({}),
  trend: z.object({ days: days(30) }).prefault({}),
  howMany: z
    .object({ days: z.number().int().min(1).max(180).default(14), historyDays: days(30) })
    .prefault({}),
  when: z
    .object({ items: z.number().int().min(1).max(500).default(10), historyDays: days(30) })
    .prefault({}),
  hygiene: z
    .object({
      staleDays: z.number().int().min(1).max(365).default(14),
      oversizedPoints: z.number().min(1).max(100).default(13),
    })
    .prefault({}),
};

const widget = <M extends string, C extends readonly [string, ...string[]], P extends z.ZodType>(
  metric: M,
  charts: C,
  params: P,
) =>
  z.object({
    id: z.string().min(1).max(64),
    metric: z.literal(metric),
    chart: z.enum(charts),
    /** Optional free-text title; without one the UI shows the metric's translated name. */
    title: z.string().trim().min(1).max(80).optional(),
    params,
  });

export const widgetSpecSchema = z.discriminatedUnion('metric', [
  widget('average_velocity', ['kpi'], p.sprints),
  widget('say_do_ratio', ['kpi'], p.sprints),
  widget('velocity', ['bar'], p.sprints),
  widget('scope_change', ['kpi'], p.sprint),
  widget('carry_over', ['kpi'], p.none),
  widget('sprint_burndown', ['line'], p.sprint),
  widget('sprint_burnup', ['line'], p.sprint),
  widget('cycle_time', ['kpi', 'table'], p.percentile),
  widget('lead_time', ['kpi', 'table'], p.percentile),
  widget('throughput', ['bar'], p.weeks),
  widget('throughput_rate', ['kpi'], p.rate),
  widget('wip', ['kpi'], p.none),
  widget('wip_trend', ['line'], p.trend),
  widget('aging_wip', ['table'], p.window),
  widget('cfd', ['area'], p.trend),
  widget('flow_efficiency', ['kpi'], p.window),
  widget('forecast_how_many', ['table'], p.howMany),
  widget('forecast_when', ['table'], p.when),
  widget('hygiene', ['table'], p.hygiene),
]);

export type WidgetSpec = z.infer<typeof widgetSpecSchema>;
export type WidgetSpecInput = z.input<typeof widgetSpecSchema>;
export type MetricKey = WidgetSpec['metric'];
export const METRIC_KEYS: MetricKey[] = widgetSpecSchema.options.map((o) => o.shape.metric.value);

/** Parses stored widgets, dropping (not failing on) any that no longer validate. */
export function parseWidgets(value: unknown): WidgetSpec[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((w) => {
    const parsed = widgetSpecSchema.safeParse(w);
    return parsed.success ? [parsed.data] : [];
  });
}
```

`packages/dashboards/src/widget-data.ts`:
```ts
/** What a widget renders. Labels are message keys (dashboard.series.*, dashboard.columns.*). */
export type KpiFormat = 'number' | 'percent' | 'days' | 'points' | 'issues' | 'per_week';

export type WidgetData =
  | {
      kind: 'kpi';
      value: number | null;
      format: KpiFormat;
      /** Optional footnote (message key under dashboard.hints) with interpolation values. */
      hint?: { key: string; values?: Record<string, string | number> };
    }
  | {
      kind: 'series';
      chart: 'bar' | 'line' | 'area';
      /** Row field holding the x value (a yyyy-mm-dd day or a label). */
      x: string;
      series: { key: string; stacked?: boolean; dashed?: boolean }[];
      rows: Record<string, string | number | null>[];
    }
  | {
      kind: 'table';
      /** `code`/`codes` cells hold message keys (dashboard.codes.*) the UI translates. */
      columns: { key: string; type: 'text' | 'number' | 'days' | 'date' | 'code' | 'codes' }[];
      rows: (string | number | null)[][];
    }
  | { kind: 'empty'; reason: 'no_sprint' | 'no_data' | 'no_estimates' };
```

`packages/dashboards/src/compute.ts`:
```ts
import {
  addDays,
  agingWip,
  type BoardDataset,
  carryOver,
  cumulativeFlow,
  currentSprint,
  cycleTime,
  dailyThroughputSamples,
  flowEfficiency,
  forecastHowMany,
  forecastWhen,
  hygiene,
  isoDay,
  lastClosedSprint,
  leadTime,
  type MetricSprint,
  scopeChange,
  sprintBurn,
  startOfUtcDay,
  throughputPerWeek,
  type Unit,
  velocity,
  velocitySummary,
  weeklyThroughput,
  wipNow,
  wipSeries,
} from '@agile/metrics';
import type { WidgetData } from './widget-data';
import type { WidgetSpec } from './widget-spec';

/** Fixed seed: the same data always gives the same forecast (no flicker between page loads). */
export const FORECAST_SEED = 42;

const empty = (reason: Extract<WidgetData, { kind: 'empty' }>['reason']): WidgetData => ({
  kind: 'empty',
  reason,
});

const CONFIDENCE = [50, 85, 95] as const;

/** Points need an estimation field; boards that estimate by issue count fall back to issues. */
const unitFor = (ds: BoardDataset, unit: Unit): Unit => (ds.hasEstimates ? unit : 'issues');

const pickSprint = (
  ds: BoardDataset,
  which: 'current' | 'last_closed',
): MetricSprint | undefined => (which === 'current' ? currentSprint(ds) : lastClosedSprint(ds));

/** Evaluates one widget against a board's data. Pure and deterministic for a given `now`. */
export function computeWidget(spec: WidgetSpec, ds: BoardDataset, now: Date): WidgetData {
  switch (spec.metric) {
    case 'average_velocity':
    case 'say_do_ratio': {
      const unit = unitFor(ds, spec.params.unit);
      const rows = velocity(ds, { sprints: spec.params.sprints, unit });
      if (rows.length === 0) return empty('no_sprint');
      const summary = velocitySummary(rows);
      return spec.metric === 'average_velocity'
        ? {
            kind: 'kpi',
            value: summary.average,
            format: unit,
            hint: { key: 'lastSprints', values: { count: rows.length } },
          }
        : {
            kind: 'kpi',
            value: summary.sayDoRatio,
            format: 'percent',
            hint: { key: 'lastSprints', values: { count: rows.length } },
          };
    }
    case 'velocity': {
      const rows = velocity(ds, {
        sprints: spec.params.sprints,
        unit: unitFor(ds, spec.params.unit),
      });
      if (rows.length === 0) return empty('no_sprint');
      return {
        kind: 'series',
        chart: 'bar',
        x: 'sprint',
        series: [{ key: 'committed' }, { key: 'completed' }],
        rows: rows.map((r) => ({ sprint: r.name, committed: r.committed, completed: r.completed })),
      };
    }
    case 'scope_change': {
      const sprint = pickSprint(ds, spec.params.sprint);
      const unit = unitFor(ds, spec.params.unit);
      const change = sprint ? scopeChange(ds, sprint, { unit, now }) : null;
      if (!sprint || !change) return empty('no_sprint');
      return {
        kind: 'kpi',
        value: change.added,
        format: unit,
        hint: { key: 'scopeRemoved', values: { removed: change.removed, sprint: sprint.name } },
      };
    }
    case 'carry_over': {
      const sprint = lastClosedSprint(ds);
      const result = sprint ? carryOver(ds, sprint) : null;
      if (!sprint || !result) return empty('no_sprint');
      return {
        kind: 'kpi',
        value: result.count,
        format: 'issues',
        hint: { key: 'carriedFrom', values: { sprint: sprint.name } },
      };
    }
    case 'sprint_burndown':
    case 'sprint_burnup': {
      const sprint = pickSprint(ds, spec.params.sprint);
      if (!sprint) return empty('no_sprint');
      const rows = sprintBurn(ds, sprint, { unit: unitFor(ds, spec.params.unit), now });
      if (rows.length === 0) return empty('no_sprint');
      return spec.metric === 'sprint_burndown'
        ? {
            kind: 'series',
            chart: 'line',
            x: 'day',
            series: [{ key: 'remaining' }, { key: 'ideal', dashed: true }],
            rows: rows.map((r) => ({ day: r.day, remaining: r.remaining, ideal: r.ideal })),
          }
        : {
            kind: 'series',
            chart: 'line',
            x: 'day',
            series: [{ key: 'scope', dashed: true }, { key: 'completed' }],
            rows: rows.map((r) => ({ day: r.day, scope: r.scope, completed: r.completed })),
          };
    }
    case 'cycle_time':
    case 'lead_time': {
      const opts = { windowDays: spec.params.windowDays, now };
      const stats = spec.metric === 'cycle_time' ? cycleTime(ds, opts) : leadTime(ds, opts);
      if (stats.count === 0) return empty('no_data');
      if (spec.chart === 'kpi') {
        return {
          kind: 'kpi',
          value: stats[`p${spec.params.percentile}`],
          format: 'days',
          hint: { key: 'finishedIn', values: { count: stats.count, days: spec.params.windowDays } },
        };
      }
      return {
        kind: 'table',
        columns: [
          { key: 'percentile', type: 'text' },
          { key: 'days', type: 'days' },
        ],
        rows: CONFIDENCE.map((p) => [`${p}%`, stats[`p${p}`]]),
      };
    }
    case 'throughput': {
      const rows = weeklyThroughput(ds, { weeks: spec.params.weeks, now });
      return {
        kind: 'series',
        chart: 'bar',
        x: 'week',
        series: [{ key: 'done' }],
        rows: rows.map((r) => ({ week: r.weekStart, done: r.count })),
      };
    }
    case 'throughput_rate':
      return {
        kind: 'kpi',
        value: throughputPerWeek(ds, { days: spec.params.days, now }),
        format: 'per_week',
        hint: { key: 'lastDays', values: { days: spec.params.days } },
      };
    case 'wip':
      return { kind: 'kpi', value: wipNow(ds), format: 'issues' };
    case 'wip_trend':
      return {
        kind: 'series',
        chart: 'line',
        x: 'day',
        series: [{ key: 'wip' }],
        rows: wipSeries(ds, { days: spec.params.days, now }).map((r) => ({
          day: r.day,
          wip: r.wip,
        })),
      };
    case 'aging_wip': {
      const items = agingWip(ds, { windowDays: spec.params.windowDays, now });
      if (items.length === 0) return empty('no_data');
      return {
        kind: 'table',
        columns: [
          { key: 'key', type: 'text' },
          { key: 'summary', type: 'text' },
          { key: 'age', type: 'days' },
          { key: 'status', type: 'code' },
        ],
        rows: items.map((i) => [
          i.key,
          i.summary,
          i.ageDays,
          i.blocked ? 'blocked' : i.overP85 ? 'late' : 'on_track',
        ]),
      };
    }
    case 'cfd':
      return {
        kind: 'series',
        chart: 'area',
        x: 'day',
        series: [
          { key: 'done', stacked: true },
          { key: 'inProgress', stacked: true },
          { key: 'todo', stacked: true },
        ],
        rows: cumulativeFlow(ds, { days: spec.params.days, now }),
      };
    case 'flow_efficiency': {
      const result = flowEfficiency(ds, { windowDays: spec.params.windowDays, now });
      if (result.efficiency === null) return empty('no_data');
      return {
        kind: 'kpi',
        value: result.efficiency,
        format: 'percent',
        hint: { key: 'blockedDays', values: { days: Math.round(result.blockedDays) } },
      };
    }
    case 'forecast_how_many': {
      const samples = dailyThroughputSamples(ds, { historyDays: spec.params.historyDays, now });
      const f = forecastHowMany(samples, { days: spec.params.days, seed: FORECAST_SEED });
      if (!f || samples.every((s) => s === 0)) return empty('no_data');
      return {
        kind: 'table',
        columns: [
          { key: 'confidence', type: 'text' },
          { key: 'items', type: 'number' },
        ],
        rows: CONFIDENCE.map((p) => [`${p}%`, f[`p${p}`]]),
      };
    }
    case 'forecast_when': {
      const samples = dailyThroughputSamples(ds, { historyDays: spec.params.historyDays, now });
      const f = forecastWhen(samples, { items: spec.params.items, seed: FORECAST_SEED });
      if (!f) return empty('no_data');
      const today = startOfUtcDay(now);
      return {
        kind: 'table',
        columns: [
          { key: 'confidence', type: 'text' },
          { key: 'date', type: 'date' },
        ],
        rows: CONFIDENCE.map((p) => [`${p}%`, isoDay(addDays(today, f[`p${p}`]))]),
      };
    }
    case 'hygiene': {
      const findings = hygiene(ds, { now, ...spec.params });
      if (findings.length === 0) return empty('no_data');
      return {
        kind: 'table',
        columns: [
          { key: 'key', type: 'text' },
          { key: 'summary', type: 'text' },
          { key: 'problems', type: 'codes' },
        ],
        rows: findings.map((f) => [f.key, f.summary, f.problems.join(',')]),
      };
    }
  }
}
```

`packages/dashboards/src/layouts.ts`:
```ts
import { type WidgetSpec, type WidgetSpecInput, widgetSpecSchema } from './widget-spec';

const build = (specs: WidgetSpecInput[]): WidgetSpec[] =>
  specs.map((s) => widgetSpecSchema.parse(s));

/** Default Scrum dashboard: sprint KPIs, velocity, burndown/burnup, hygiene. */
export const scrumLayout = (): WidgetSpec[] =>
  build([
    { id: 'avg-velocity', metric: 'average_velocity', chart: 'kpi' },
    { id: 'say-do', metric: 'say_do_ratio', chart: 'kpi' },
    { id: 'scope-added', metric: 'scope_change', chart: 'kpi' },
    { id: 'carry-over', metric: 'carry_over', chart: 'kpi' },
    { id: 'velocity', metric: 'velocity', chart: 'bar' },
    { id: 'burndown', metric: 'sprint_burndown', chart: 'line' },
    { id: 'burnup', metric: 'sprint_burnup', chart: 'line' },
    { id: 'hygiene', metric: 'hygiene', chart: 'table' },
  ]);

/** Default Kanban (flow) dashboard: flow KPIs, throughput, CFD, aging WIP, forecasts, hygiene. */
export const kanbanLayout = (): WidgetSpec[] =>
  build([
    { id: 'throughput-rate', metric: 'throughput_rate', chart: 'kpi' },
    { id: 'cycle-time', metric: 'cycle_time', chart: 'kpi' },
    { id: 'wip', metric: 'wip', chart: 'kpi' },
    { id: 'flow-efficiency', metric: 'flow_efficiency', chart: 'kpi' },
    { id: 'throughput', metric: 'throughput', chart: 'bar' },
    { id: 'cfd', metric: 'cfd', chart: 'area' },
    { id: 'aging-wip', metric: 'aging_wip', chart: 'table' },
    { id: 'forecast-how-many', metric: 'forecast_how_many', chart: 'table' },
    { id: 'forecast-when', metric: 'forecast_when', chart: 'table' },
    { id: 'hygiene', metric: 'hygiene', chart: 'table' },
  ]);

/** Scrum boards get a sprint dashboard and a flow dashboard; Kanban/simple boards a flow one. */
export function defaultDashboards(boardType: 'scrum' | 'kanban' | 'simple') {
  const flow = { name: 'Flow', kind: 'kanban' as const, widgets: kanbanLayout() };
  return boardType === 'scrum'
    ? [{ name: 'Scrum', kind: 'scrum' as const, widgets: scrumLayout() }, flow]
    : [flow];
}
```

`packages/dashboards/src/dataset.ts`:
```ts
import {
  type Db,
  jiraBoardIssues,
  jiraBoardSprints,
  jiraBoards,
  jiraIssueChanges,
  jiraIssues,
  jiraIssueTransitions,
  jiraSprintIssues,
  jiraSprints,
  jiraStatusMappings,
  withOrg,
} from '@agile/db';
import type {
  BoardDataset,
  Interval,
  MetricIssue,
  MetricSprint,
  StatusCategory,
  StatusPeriod,
} from '@agile/metrics';
import { and, asc, eq, inArray } from 'drizzle-orm';

export interface StatusMapping {
  category: StatusCategory;
  blocked: boolean;
}

type IssueRow = typeof jiraIssues.$inferSelect;
type TransitionRow = Pick<
  typeof jiraIssueTransitions.$inferSelect,
  'at' | 'fromStatusId' | 'toStatusId'
>;
type ChangeRow = Pick<
  typeof jiraIssueChanges.$inferSelect,
  'at' | 'kind' | 'fromValue' | 'toValue'
>;

/** Statuses missing from the mapping (deleted in Jira, or never seen on the board) count as to-do. */
const UNMAPPED: StatusMapping = { category: 'todo', blocked: false };

const num = (v: string | null): number | null => {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * One stored issue + its ordered history → the metrics model. The issue starts in the `from` status
 * of its first transition (or its current status when it never moved).
 */
export function toMetricIssue(
  issue: IssueRow,
  transitions: TransitionRow[],
  changes: ChangeRow[],
  mappings: Map<string, StatusMapping>,
): MetricIssue {
  const map = (statusId: string) => mappings.get(statusId) ?? UNMAPPED;
  const created = issue.jiraCreatedAt;
  const periods: StatusPeriod[] = [];
  const push = (from: Date, statusId: string) => {
    const m = map(statusId);
    const at = from.getTime() < created.getTime() ? created : from;
    const last = periods.at(-1);
    if (last && last.category === m.category && last.blocked === m.blocked) return;
    if (last && last.from.getTime() === at.getTime()) periods.pop();
    periods.push({ from: at, category: m.category, blocked: m.blocked });
  };
  push(created, transitions[0]?.fromStatusId ?? transitions[0]?.toStatusId ?? issue.statusId);
  for (const t of transitions) push(t.at, t.toStatusId);

  const flagged: Interval[] = [];
  const flags = changes.filter((c) => c.kind === 'flag');
  let flaggedSince: Date | null = flags[0]?.fromValue === 'on' ? created : null;
  for (const c of flags) {
    if (c.toValue === 'on' && !flaggedSince) flaggedSince = c.at;
    if (c.toValue !== 'on' && flaggedSince) {
      flagged.push({ from: flaggedSince, to: c.at });
      flaggedSince = null;
    }
  }
  if (flaggedSince) flagged.push({ from: flaggedSince, to: null });

  return {
    id: issue.id,
    key: issue.key,
    summary: issue.summary,
    type: issue.issueType,
    createdAt: created,
    updatedAt: issue.jiraUpdatedAt,
    assignee: issue.assigneeName ?? issue.assigneeId,
    estimate: issue.estimate,
    estimateChanges: changes
      .filter((c) => c.kind === 'estimate')
      .map((c) => ({ at: c.at, from: num(c.fromValue), to: num(c.toValue) })),
    statusPeriods: periods,
    flagged,
  };
}

/**
 * Everything the metrics need for one board, read in a handful of queries. Sub-tasks are left
 * out: Jira's own sprint and flow reports count their parent items. null if the board is unknown.
 */
export async function loadBoardDataset(
  db: Db,
  orgId: string,
  boardId: string,
): Promise<BoardDataset | null> {
  return withOrg(db, orgId, async (tx) => {
    const [board] = await tx.select().from(jiraBoards).where(eq(jiraBoards.id, boardId));
    if (!board) return null;
    const mappings = new Map(
      (
        await tx.select().from(jiraStatusMappings).where(eq(jiraStatusMappings.boardId, boardId))
      ).map((m) => [m.jiraStatusId, { category: m.category, blocked: m.blocked }]),
    );
    const onBoard = (issueCol: typeof jiraIssues.id | typeof jiraIssueTransitions.issueId) =>
      and(eq(jiraBoardIssues.boardId, boardId), eq(jiraBoardIssues.issueId, issueCol));

    const issues = (
      await tx
        .select({ issue: jiraIssues })
        .from(jiraIssues)
        .innerJoin(jiraBoardIssues, onBoard(jiraIssues.id))
        .where(eq(jiraIssues.isSubtask, false))
    ).map((r) => r.issue);
    const ids = new Set(issues.map((i) => i.id));

    const transitions = await tx
      .select({
        issueId: jiraIssueTransitions.issueId,
        at: jiraIssueTransitions.at,
        fromStatusId: jiraIssueTransitions.fromStatusId,
        toStatusId: jiraIssueTransitions.toStatusId,
      })
      .from(jiraIssueTransitions)
      .innerJoin(jiraBoardIssues, onBoard(jiraIssueTransitions.issueId))
      .orderBy(asc(jiraIssueTransitions.issueId), asc(jiraIssueTransitions.seq));
    const changes = await tx
      .select({
        issueId: jiraIssueChanges.issueId,
        at: jiraIssueChanges.at,
        kind: jiraIssueChanges.kind,
        fromValue: jiraIssueChanges.fromValue,
        toValue: jiraIssueChanges.toValue,
      })
      .from(jiraIssueChanges)
      .innerJoin(
        jiraBoardIssues,
        and(
          eq(jiraBoardIssues.boardId, boardId),
          eq(jiraBoardIssues.issueId, jiraIssueChanges.issueId),
        ),
      )
      .orderBy(asc(jiraIssueChanges.issueId), asc(jiraIssueChanges.seq));

    const sprints = (
      await tx
        .select({ sprint: jiraSprints })
        .from(jiraSprints)
        .innerJoin(
          jiraBoardSprints,
          and(eq(jiraBoardSprints.boardId, boardId), eq(jiraBoardSprints.sprintId, jiraSprints.id)),
        )
    ).map((r) => r.sprint);
    const sprintIds = sprints.map((s) => s.jiraSprintId);
    const membership =
      sprintIds.length === 0
        ? []
        : await tx
            .select()
            .from(jiraSprintIssues)
            .where(
              and(
                eq(jiraSprintIssues.connectionId, board.connectionId),
                inArray(jiraSprintIssues.jiraSprintId, sprintIds),
              ),
            );

    const group = <T extends { issueId: string }>(rows: T[]) => {
      const byIssue = new Map<string, T[]>();
      for (const r of rows) byIssue.set(r.issueId, [...(byIssue.get(r.issueId) ?? []), r]);
      return byIssue;
    };
    const transitionsBy = group(transitions);
    const changesBy = group(changes);

    return {
      hasEstimates: board.estimationFieldId !== null,
      issues: issues.map((i) =>
        toMetricIssue(i, transitionsBy.get(i.id) ?? [], changesBy.get(i.id) ?? [], mappings),
      ),
      sprints: sprints.map(
        (s): MetricSprint => ({
          id: s.id,
          name: s.name,
          state: s.state,
          startAt: s.startAt,
          endAt: s.endAt,
          completeAt: s.completeAt,
          members: membership
            .filter((m) => m.jiraSprintId === s.jiraSprintId && ids.has(m.issueId))
            .map((m) => ({ issueId: m.issueId, addedAt: m.addedAt, removedAt: m.removedAt })),
        }),
      ),
    };
  });
}
```

`packages/dashboards/src/store.ts`:
```ts
import { type Db, dashboards, withOrg } from '@agile/db';
import { and, asc, eq } from 'drizzle-orm';
import { defaultDashboards } from './layouts';
import { parseWidgets, type WidgetSpec, widgetSpecSchema } from './widget-spec';

export interface DashboardView {
  id: string;
  name: string;
  kind: 'scrum' | 'kanban' | 'custom';
  widgets: WidgetSpec[];
}

/** Creates the user's default dashboards for a board the first time (idempotent, race-safe). */
export async function ensureDefaultDashboards(
  db: Db,
  orgId: string,
  userId: string,
  board: { id: string; type: 'scrum' | 'kanban' | 'simple' },
): Promise<void> {
  await withOrg(db, orgId, async (tx) => {
    await tx
      .insert(dashboards)
      .values(
        defaultDashboards(board.type).map((d, position) => ({
          orgId,
          userId,
          boardId: board.id,
          name: d.name,
          kind: d.kind,
          position,
          widgets: d.widgets,
        })),
      )
      .onConflictDoNothing();
  });
}

export async function listDashboards(
  db: Db,
  orgId: string,
  userId: string,
  boardId: string,
): Promise<DashboardView[]> {
  const rows = await withOrg(db, orgId, (tx) =>
    tx
      .select()
      .from(dashboards)
      .where(and(eq(dashboards.userId, userId), eq(dashboards.boardId, boardId)))
      .orderBy(asc(dashboards.position), asc(dashboards.createdAt)),
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    widgets: parseWidgets(r.widgets),
  }));
}

/** Replaces a dashboard's widgets after validating every spec (Phase 4's agent writes through here). */
export async function saveDashboardWidgets(
  db: Db,
  orgId: string,
  userId: string,
  dashboardId: string,
  widgets: unknown[],
): Promise<{ ok: true } | { ok: false; code: 'invalid_widget' | 'not_found' }> {
  const parsed = widgetSpecSchema.array().max(40).safeParse(widgets);
  if (!parsed.success) return { ok: false, code: 'invalid_widget' };
  const updated = await withOrg(db, orgId, (tx) =>
    tx
      .update(dashboards)
      .set({ widgets: parsed.data })
      .where(and(eq(dashboards.id, dashboardId), eq(dashboards.userId, userId)))
      .returning({ id: dashboards.id }),
  );
  return updated.length > 0 ? { ok: true } : { ok: false, code: 'not_found' };
}
```

`packages/dashboards/src/index.ts`:
```ts
export { computeWidget, FORECAST_SEED } from './compute';
export { loadBoardDataset, type StatusMapping, toMetricIssue } from './dataset';
export { defaultDashboards, kanbanLayout, scrumLayout } from './layouts';
export {
  type DashboardView,
  ensureDefaultDashboards,
  listDashboards,
  saveDashboardWidgets,
} from './store';
export type { KpiFormat, WidgetData } from './widget-data';
export {
  METRIC_KEYS,
  type MetricKey,
  parseWidgets,
  type WidgetSpec,
  type WidgetSpecInput,
  widgetSpecSchema,
} from './widget-spec';
```

- [ ] **Step 5: Run tests, lint, typecheck**

Run: `pnpm vitest run --project dashboards && pnpm lint && pnpm typecheck`
Expected: PASS — 17 tests. The demo KPIs come out exactly: Scrum `{ avg-velocity: 19, say-do: 0.95, scope-added: 2, carry-over: 1 }`, velocity rows 20/19 for sprints 1–3, burndown starting at 20; Flow `{ throughput-rate: 3, cycle-time: 8, wip: 4, flow-efficiency: 0.8261 }`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(dashboards): widget catalog, default Scrum and Kanban layouts, dataset loader

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Web — board selection, status mapping and "Sync now"

**Files:**
- Create (shadcn): `apps/web/src/components/ui/{checkbox,table}.tsx` via `shadcn add`
- Create: `apps/web/src/server/sync.ts`, `apps/web/src/app/(app)/settings/jira/[connectionId]/{page.tsx,actions.ts,sync-controls.tsx,board-selection-form.tsx,status-mapping-form.tsx}`
- Modify: `apps/web/package.json`, `apps/web/next.config.ts`, `apps/web/src/app/(app)/settings/jira/jira-connection-item.tsx` ("Boards" link), `apps/web/src/components/page-breadcrumb.tsx`, `apps/web/messages/{en,fr}.json`, `e2e/playwright.config.ts` (worker web server)
- Test: `e2e/tests/sync-dashboards.spec.ts` (first part)

**Interfaces:**
- `syncDeps(): SyncDeps` (connection deps + Atlassian OAuth client when configured), `syncQueue(): Promise<PgBoss>` (one lazily started pg-boss **producer** per server process, kept across dev reloads; a failed start is retried on the next request).
- Server actions (`[connectionId]/actions.ts`): `discoverBoardsAction(connectionId)`, `saveBoardSelectionAction(connectionId, prev, form)` (`board` = selected ids), `saveStatusMappingAction(connectionId, boardId, prev, form)` (`status` = ids; `category:<id>`; `blocked:<id>` = `on`), `requestSyncAction(connectionId)`; all return `ActionState = { status: 'idle' } | { status: 'ok'; queued? } | { status: 'error'; code }`, validate ids with `z.uuid()`, map `ForbiddenError` → `forbidden_role`, and revalidate the page.
- Page `/settings/jira/<connectionId>`: sync status badge + "Sync now" (polls with `router.refresh()` every 2 s while queued/running; the label is formatted on the server), "Load boards from Jira"/"Refresh boards", a board list (shadcn `item` + `checkbox` + `badge`), one status-mapping card per selected board (shadcn `table` + `native-select` + `checkbox`; `data-board`/`data-status` attributes for tests). Members see everything read-only.
- Forms use controlled state + `onSubmit`/`startTransition` (not `<form action>`): React resets a form after an action, and remounting the forms on revalidation would drop the "saved" toast.

**UI rule:** shadcn components only (`item`, `checkbox`, `badge`, `table`, `native-select`, `card`, `empty`, `button`, `sonner`); every string from `messages/*.json`.

- [ ] **Step 1: Failing e2e (part 1: connect → boards → mapping → sync)**

`e2e/playwright.config.ts` — start the worker (migrating first: Playwright starts web servers **before** `globalSetup`):
```diff
diff --git a/e2e/playwright.config.ts b/e2e/playwright.config.ts
--- a/e2e/playwright.config.ts
+++ b/e2e/playwright.config.ts
@@ -1,5 +1,9 @@
 import { defineConfig } from '@playwright/test';
 
+// Migrations run as the owner; the worker starts before globalSetup, so it migrates first.
+const ownerUrl =
+  process.env.DATABASE_OWNER_URL ?? 'postgres://agile:agile_dev_password@localhost:5433/agile';
+
 const env = {
   // CI points this at its Postgres service; locally it's the dev compose DB on 5433.
   DATABASE_URL:
@@ -19,6 +23,20 @@ export default defineConfig({
   use: { baseURL: 'http://localhost:3200', trace: 'retain-on-failure' },
   webServer: [
     { command: 'pnpm mocks', port: 4010, reuseExistingServer: !process.env.CI },
+    {
+      // The sync worker (pg-boss); its /health answers once it is connected and scheduled.
+      // Playwright starts web servers before globalSetup, so the schema is migrated here first.
+      command: 'pnpm --filter @agile/db migrate && pnpm --filter @agile/worker start',
+      url: 'http://127.0.0.1:4030/health',
+      env: {
+        ...env,
+        DATABASE_OWNER_URL: ownerUrl,
+        WORKER_HEALTH_PORT: '4030',
+        SYNC_INTERVAL_MINUTES: '60',
+      },
+      reuseExistingServer: !process.env.CI,
+      timeout: 60_000,
+    },
     {
       command: 'pnpm --filter @agile/web exec next dev --port 3200',
       url: 'http://localhost:3200/login',
```

`e2e/tests/sync-dashboards.spec.ts`:
```ts
import { expect, type Page, test } from '@playwright/test';
import { connectionItem, signUpWithWorkspace } from '../helpers';

// The mock Jira serves the demo dataset (packages/jira/src/testing/demo-dataset.ts); the numbers
// below are the ones it is built to produce.
test.describe.configure({ timeout: 180_000 });

async function connectDemoJira(page: Page) {
  await page.goto('/settings/jira');
  await page.getByLabel('Connection name').fill('Demo Jira');
  await page.getByLabel('Jira URL').fill('http://127.0.0.1:4010');
  await page.getByLabel('Data Center / Server').check();
  await page.getByLabel('Personal access token').fill('good-pat');
  await page.getByRole('button', { name: 'Test and save' }).click();
  await expect(connectionItem(page, 'Demo Jira').getByText('Connected')).toBeVisible();
}

// The first visit of a route makes `next dev` compile it (recharts, pg-boss…), which can be slow.
const firstCompile = { timeout: 60_000 };

test('select boards, map statuses and sync them', async ({ page }) => {
  await signUpWithWorkspace(page);
  await connectDemoJira(page);

  // Boards
  await connectionItem(page, 'Demo Jira').getByRole('link', { name: 'Boards' }).click();
  await expect(page.getByText('No boards loaded yet.')).toBeVisible(firstCompile);
  await page.getByRole('button', { name: 'Load boards from Jira' }).click();
  await page.getByLabel('DEMO Scrum').check();
  await page.getByLabel('OPS Kanban').check();
  await page.getByRole('button', { name: 'Save selection' }).click();
  await expect(page.getByText('Board selection saved.')).toBeVisible();

  // Status mapping, suggested from Jira's categories ("Blocked" is a waiting state)
  const scrumMapping = page.locator('[data-board="DEMO Scrum"]');
  const blocked = scrumMapping.locator('[data-status="Blocked"]');
  await expect(blocked.getByRole('combobox')).toHaveValue('in_progress');
  await expect(blocked.getByRole('checkbox')).toBeChecked();
  const review = scrumMapping.locator('[data-status="In Review"]');
  await review.getByRole('checkbox').check();
  await scrumMapping.getByRole('button', { name: 'Save mapping' }).click();
  await expect(page.getByText('Status mapping saved.')).toBeVisible();
  // Undo it: the dashboards (Task 13) are checked against the default mapping.
  await page
    .locator('[data-board="DEMO Scrum"] [data-status="In Review"]')
    .getByRole('checkbox')
    .uncheck();
  await page
    .locator('[data-board="DEMO Scrum"]')
    .getByRole('button', { name: 'Save mapping' })
    .click();

  // Sync (runs in the worker)
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByText(/^Synced /)).toBeVisible({ timeout: 90_000 });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `CI=true pnpm e2e --grep "select boards"`
Expected: FAIL — the connection card has no "Boards" link.

- [ ] **Step 3: shadcn components and dependencies**

Run:
```bash
pnpm --filter @agile/web exec shadcn add checkbox table --yes
pnpm --filter @agile/web add --save-exact pg-boss@12.36.0 '@agile/sync@workspace:*'
```
Expected: `src/components/ui/checkbox.tsx` and `table.tsx` created. Check `apps/web/package.json` lists `"@agile/sync": "workspace:*"` and `"pg-boss": "12.36.0"` (exact).

`apps/web/next.config.ts` — transpile the new workspace package, keep pg-boss (and its `pg` driver) out of the bundle:
```ts
  transpilePackages: [
    '@agile/auth',
    '@agile/config',
    '@agile/connections',
    '@agile/crypto',
    '@agile/db',
    '@agile/jira',
    '@agile/llm',
    '@agile/net',
    '@agile/sync',
  ],
  // Node-only database clients: loaded at runtime instead of being bundled.
  serverExternalPackages: ['postgres', 'pg-boss'],
```

- [ ] **Step 4: Server helpers, actions, components, page**

`apps/web/src/server/sync.ts`:
```ts
import 'server-only';
import type { SyncDeps } from '@agile/sync';
import { startSyncQueue } from '@agile/sync';
import type { PgBoss } from 'pg-boss';
import { atlassianOAuth } from './atlassian';
import { connectionDeps, services } from './context';

/** Dependencies of the sync services (board discovery needs to refresh OAuth tokens too). */
export function syncDeps(): SyncDeps {
  return { ...connectionDeps(), oauth: atlassianOAuth() ?? undefined };
}

// One pg-boss producer per server process, kept across dev hot-reloads like the db pool.
const g = globalThis as unknown as { __agileSyncQueue?: Promise<PgBoss> };

/** Lazily started job producer used by "Sync now" (the worker app runs the jobs). */
export function syncQueue(): Promise<PgBoss> {
  g.__agileSyncQueue ??= startSyncQueue(services().env.DATABASE_URL, {
    role: 'producer',
    onError: (error) =>
      console.error(JSON.stringify({ level: 'error', event: 'queue_error', error: error.name })),
  }).catch((error: unknown) => {
    g.__agileSyncQueue = undefined; // retry on the next request
    throw error;
  });
  return g.__agileSyncQueue;
}
```

`apps/web/src/app/(app)/settings/jira/[connectionId]/actions.ts`:
```ts
'use server';

import { ForbiddenError } from '@agile/connections';
import { discoverBoards, requestSync, saveStatusMappings, setBoardSelection } from '@agile/sync';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireActor, services } from '@/server/context';
import { syncDeps, syncQueue } from '@/server/sync';

export type ActionState =
  | { status: 'idle' }
  | { status: 'ok'; queued?: boolean }
  | { status: 'error'; code: string };

const uuid = z.uuid();
const path = (connectionId: string) => `/settings/jira/${connectionId}`;

async function guarded(run: () => Promise<ActionState>): Promise<ActionState> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ForbiddenError) return { status: 'error', code: 'forbidden_role' };
    throw e;
  }
}

export async function discoverBoardsAction(connectionId: string): Promise<ActionState> {
  const actor = await requireActor();
  if (!uuid.safeParse(connectionId).success) return { status: 'error', code: 'not_found' };
  return guarded(async () => {
    const result = await discoverBoards(syncDeps(), actor, connectionId);
    if (!result.ok) return { status: 'error', code: result.code };
    revalidatePath(path(connectionId));
    return { status: 'ok' };
  });
}

export async function saveBoardSelectionAction(
  connectionId: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  const ids = z.array(uuid).max(500).safeParse(form.getAll('board'));
  if (!uuid.safeParse(connectionId).success || !ids.success) {
    return { status: 'error', code: 'invalid_input' };
  }
  return guarded(async () => {
    const result = await setBoardSelection(syncDeps(), actor, connectionId, ids.data);
    if (!result.ok) return { status: 'error', code: result.code };
    revalidatePath(path(connectionId));
    revalidatePath('/');
    return { status: 'ok' };
  });
}

const mappingEntry = z.object({
  jiraStatusId: z.string().min(1).max(64),
  category: z.enum(['todo', 'in_progress', 'done']),
  blocked: z.boolean(),
});

export async function saveStatusMappingAction(
  connectionId: string,
  boardId: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  const entries = z
    .array(mappingEntry)
    .min(1)
    .max(300)
    .safeParse(
      form.getAll('status').map((id) => ({
        jiraStatusId: id,
        category: form.get(`category:${id}`),
        blocked: form.get(`blocked:${id}`) === 'on',
      })),
    );
  if (!uuid.safeParse(boardId).success || !entries.success) {
    return { status: 'error', code: 'invalid_input' };
  }
  return guarded(async () => {
    const result = await saveStatusMappings(syncDeps(), actor, boardId, entries.data);
    if (!result.ok) return { status: 'error', code: result.code };
    revalidatePath(path(connectionId));
    return { status: 'ok' };
  });
}

export async function requestSyncAction(connectionId: string): Promise<ActionState> {
  const actor = await requireActor();
  if (!uuid.safeParse(connectionId).success) return { status: 'error', code: 'not_found' };
  return guarded(async () => {
    const result = await requestSync(
      { db: services().db, boss: await syncQueue() },
      actor,
      connectionId,
    );
    if (!result.ok) return { status: 'error', code: result.code };
    revalidatePath(path(connectionId));
    return { status: 'ok', queued: result.queued };
  });
}
```

`apps/web/src/app/(app)/settings/jira/[connectionId]/sync-controls.tsx`:
```tsx
'use client';

import type { SyncStateView } from '@agile/sync';
import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useTransition } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { discoverBoardsAction, requestSyncAction } from './actions';

const BUSY = new Set(['queued', 'running']);

/**
 * Sync status + "Sync now"; refreshes the page every 2 s while a sync is queued or running.
 * `label` and `error` are formatted on the server (no clock/time-zone mismatch on hydration).
 */
export function SyncControls({
  connectionId,
  status,
  label,
  error,
  canManage,
  hasSelection,
}: {
  connectionId: string;
  status: SyncStateView['status'];
  label: string;
  error: string | null;
  canManage: boolean;
  hasSelection: boolean;
}) {
  const t = useTranslations('boards');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const busy = BUSY.has(status);

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => router.refresh(), 2_000);
    return () => clearInterval(timer);
  }, [busy, router]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Badge
        variant={status === 'error' ? 'destructive' : status === 'ok' ? 'default' : 'secondary'}
      >
        {label}
      </Badge>
      {error && <span className="text-sm text-destructive">{error}</span>}
      {canManage && (
        <Button
          size="sm"
          disabled={pending || busy || !hasSelection}
          onClick={() =>
            startTransition(async () => {
              const r = await requestSyncAction(connectionId);
              if (r.status === 'error')
                toast.error(
                  t.has(`errors.${r.code}`) ? t(`errors.${r.code}`) : t('errors.unknown'),
                );
              else
                toast.success(
                  r.status === 'ok' && r.queued === false
                    ? t('sync.alreadyQueued')
                    : t('sync.requested'),
                );
              router.refresh();
            })
          }
        >
          <RefreshCw />
          {t('sync.now')}
        </Button>
      )}
    </div>
  );
}

/** Reads (or re-reads) the connection's boards from Jira. */
export function DiscoverBoardsButton({
  connectionId,
  label,
  variant = 'outline',
}: {
  connectionId: string;
  label: string;
  variant?: 'default' | 'outline';
}) {
  const t = useTranslations('boards');
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      variant={variant}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const r = await discoverBoardsAction(connectionId);
          if (r.status === 'error') {
            toast.error(t.has(`errors.${r.code}`) ? t(`errors.${r.code}`) : t('errors.unknown'));
          }
        })
      }
    >
      {label}
    </Button>
  );
}
```

`apps/web/src/app/(app)/settings/jira/[connectionId]/board-selection-form.tsx`:
```tsx
'use client';

import type { BoardView } from '@agile/sync';
import { useTranslations } from 'next-intl';
import { startTransition, useActionState, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { type ActionState, saveBoardSelectionAction } from './actions';

export function BoardSelectionForm({
  connectionId,
  boards,
  canManage,
}: {
  connectionId: string;
  boards: BoardView[];
  canManage: boolean;
}) {
  const t = useTranslations('boards');
  const [selected, setSelected] = useState(
    () => new Set(boards.filter((b) => b.selected).map((b) => b.id)),
  );
  const [state, action, pending] = useActionState<ActionState, FormData>(
    saveBoardSelectionAction.bind(null, connectionId),
    { status: 'idle' },
  );

  useEffect(() => {
    if (state.status === 'ok') toast.success(t('selectionSaved'));
    if (state.status === 'error') {
      toast.error(t.has(`errors.${state.code}`) ? t(`errors.${state.code}`) : t('errors.unknown'));
    }
  }, [state, t]);

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('selectionTitle')}</CardTitle>
        <CardDescription>{t('selectionDescription')}</CardDescription>
      </CardHeader>
      {/* onSubmit + startTransition (not <form action>): React would reset the form after the action. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData();
          for (const id of selected) data.append('board', id);
          startTransition(() => action(data));
        }}
      >
        <CardContent>
          <ItemGroup className="gap-2">
            {boards.map((b) => {
              const inputId = `board-${b.id}`;
              return (
                <Item key={b.id} variant="outline" size="sm" asChild>
                  <label htmlFor={inputId}>
                    <ItemMedia>
                      <Checkbox
                        id={inputId}
                        checked={selected.has(b.id)}
                        disabled={!canManage}
                        onCheckedChange={(v) => toggle(b.id, v === true)}
                      />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{b.name}</ItemTitle>
                      <ItemDescription>
                        {[
                          b.projectKey,
                          b.usesEstimates ? t('estimates.points') : t('estimates.count'),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Badge variant="outline">{t(`types.${b.type}`)}</Badge>
                    </ItemActions>
                  </label>
                </Item>
              );
            })}
          </ItemGroup>
        </CardContent>
        {canManage && (
          <CardFooter className="mt-4">
            <Button type="submit" disabled={pending}>
              {t('saveSelection')}
            </Button>
          </CardFooter>
        )}
      </form>
    </Card>
  );
}
```

`apps/web/src/app/(app)/settings/jira/[connectionId]/status-mapping-form.tsx`:
```tsx
'use client';

import type { StatusMappingView } from '@agile/sync';
import { useTranslations } from 'next-intl';
import { startTransition, useActionState, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { type ActionState, saveStatusMappingAction } from './actions';

type Category = StatusMappingView['category'];
const CATEGORIES: Category[] = ['todo', 'in_progress', 'done'];

/** Jira status → To do / In progress / Done (+ "waiting" for blocked in-progress states). */
export function StatusMappingForm({
  connectionId,
  boardId,
  boardName,
  mappings,
  canManage,
}: {
  connectionId: string;
  boardId: string;
  boardName: string;
  mappings: StatusMappingView[];
  canManage: boolean;
}) {
  const t = useTranslations('boards');
  const [rows, setRows] = useState(mappings);
  const [state, action, pending] = useActionState<ActionState, FormData>(
    saveStatusMappingAction.bind(null, connectionId, boardId),
    { status: 'idle' },
  );

  useEffect(() => {
    if (state.status === 'ok') toast.success(t('mappingSaved'));
    if (state.status === 'error') {
      toast.error(t.has(`errors.${state.code}`) ? t(`errors.${state.code}`) : t('errors.unknown'));
    }
  }, [state, t]);

  const update = (id: string, patch: Partial<Pick<StatusMappingView, 'category' | 'blocked'>>) =>
    setRows((prev) => prev.map((r) => (r.jiraStatusId === id ? { ...r, ...patch } : r)));

  return (
    <Card data-board={boardName}>
      <CardHeader>
        <CardTitle>{t('mappingTitle', { board: boardName })}</CardTitle>
        <CardDescription>{t('mappingDescription')}</CardDescription>
      </CardHeader>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData();
          for (const r of rows) {
            data.append('status', r.jiraStatusId);
            data.set(`category:${r.jiraStatusId}`, r.category);
            if (r.blocked) data.set(`blocked:${r.jiraStatusId}`, 'on');
          }
          startTransition(() => action(data));
        }}
      >
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('mappingColumns.status')}</TableHead>
                <TableHead>{t('mappingColumns.jiraCategory')}</TableHead>
                <TableHead>{t('mappingColumns.mapsTo')}</TableHead>
                <TableHead>{t('mappingColumns.waiting')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.jiraStatusId} data-status={r.statusName}>
                  <TableCell className="font-medium">{r.statusName}</TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {t.has(`jiraCategories.${r.jiraCategory}`)
                        ? t(`jiraCategories.${r.jiraCategory}`)
                        : r.jiraCategory}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <NativeSelect
                      size="sm"
                      aria-label={t('mappingColumns.mapsTo')}
                      value={r.category}
                      disabled={!canManage}
                      onChange={(e) =>
                        update(r.jiraStatusId, {
                          category: e.target.value as Category,
                          blocked: e.target.value === 'in_progress' ? r.blocked : false,
                        })
                      }
                    >
                      {CATEGORIES.map((c) => (
                        <NativeSelectOption key={c} value={c}>
                          {t(`categories.${c}`)}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </TableCell>
                  <TableCell>
                    <Checkbox
                      aria-label={t('mappingColumns.waiting')}
                      checked={r.blocked}
                      disabled={!canManage || r.category !== 'in_progress'}
                      onCheckedChange={(v) => update(r.jiraStatusId, { blocked: v === true })}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
        {canManage && (
          <CardFooter className="mt-4">
            <Button type="submit" disabled={pending}>
              {t('saveMapping')}
            </Button>
          </CardFooter>
        )}
      </form>
    </Card>
  );
}
```

`apps/web/src/app/(app)/settings/jira/[connectionId]/page.tsx`:
```tsx
import { canManageConnections } from '@agile/auth';
import { listJiraConnections } from '@agile/connections';
import { getSyncState, listBoards, listStatusMappings } from '@agile/sync';
import { LayoutGrid } from 'lucide-react';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { connectionDeps, requireActor } from '@/server/context';
import { syncDeps } from '@/server/sync';
import { BoardSelectionForm } from './board-selection-form';
import { StatusMappingForm } from './status-mapping-form';
import { DiscoverBoardsButton, SyncControls } from './sync-controls';

export default async function JiraConnectionBoardsPage({
  params,
}: {
  params: Promise<{ connectionId: string }>;
}) {
  const actor = await requireActor();
  const { connectionId } = await params;
  if (!z.uuid().safeParse(connectionId).success) notFound();
  const connection = (await listJiraConnections(connectionDeps(), actor.orgId)).find(
    (c) => c.id === connectionId,
  );
  if (!connection) notFound();

  const t = await getTranslations('boards');
  const format = await getFormatter();
  const deps = syncDeps();
  const canManage = canManageConnections(actor.roles);
  const [boards, state] = await Promise.all([
    listBoards(deps, actor.orgId, connectionId),
    getSyncState(deps, actor.orgId, connectionId),
  ]);
  const selected = boards.filter((b) => b.selected);
  const syncLabel =
    state.status === 'ok' && state.lastSuccessAt
      ? t('sync.ok', { when: format.relativeTime(state.lastSuccessAt, new Date()) })
      : t(`sync.${state.status}`);
  const syncError =
    state.status === 'error' && state.lastError
      ? t.has(`errors.${state.lastError}`)
        ? t(`errors.${state.lastError}`)
        : t('errors.unknown')
      : null;
  const mappings = await Promise.all(
    selected.map(async (b) => ({
      board: b,
      rows: await listStatusMappings(deps, actor.orgId, b.id),
    })),
  );

  return (
    <div className="mx-auto grid w-full max-w-4xl gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{connection.name}</h1>
          <p className="text-muted-foreground">{t('description')}</p>
        </div>
        {boards.length > 0 && canManage && (
          <DiscoverBoardsButton connectionId={connectionId} label={t('refresh')} />
        )}
      </div>
      <SyncControls
        connectionId={connectionId}
        status={state.status}
        label={syncLabel}
        error={syncError}
        canManage={canManage}
        hasSelection={selected.length > 0}
      />
      {boards.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutGrid />
            </EmptyMedia>
            <EmptyTitle>{t('empty')}</EmptyTitle>
            <EmptyDescription>{t('emptyHint')}</EmptyDescription>
          </EmptyHeader>
          {canManage && (
            <EmptyContent>
              <DiscoverBoardsButton
                connectionId={connectionId}
                label={t('load')}
                variant="default"
              />
            </EmptyContent>
          )}
        </Empty>
      ) : (
        // The forms keep their own state after saving (it already matches what was stored), so they
        // are not remounted: a remount would also drop the "saved" toast.
        <BoardSelectionForm connectionId={connectionId} boards={boards} canManage={canManage} />
      )}
      {mappings.map(({ board, rows }) => (
        <StatusMappingForm
          key={board.id}
          connectionId={connectionId}
          boardId={board.id}
          boardName={board.name}
          mappings={rows}
          canManage={canManage}
        />
      ))}
    </div>
  );
}
```

`apps/web/src/app/(app)/settings/jira/jira-connection-item.tsx` (a "Boards" link for everyone; retest/remove stay owner/admin):
```tsx
import type { JiraConnectionView } from '@agile/connections';
import { Cloud, LayoutGrid, Server } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ConfirmDeleteButton } from '@/components/confirm-delete-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { deleteJiraConnectionAction, retestJiraConnectionAction } from './actions';

export async function JiraConnectionItem({
  c,
  canManage,
}: {
  c: JiraConnectionView;
  canManage: boolean;
}) {
  const t = await getTranslations('jira');
  const status = { ok: t('connected'), error: t('failing'), untested: t('untested') }[c.status];
  const Icon = c.deployment === 'cloud' ? Cloud : Server;
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {c.name}
          <Badge
            variant={
              c.status === 'ok' ? 'default' : c.status === 'error' ? 'destructive' : 'secondary'
            }
          >
            {status}
          </Badge>
        </ItemTitle>
        <ItemDescription>
          {c.baseUrl}
          {c.accountName ? ` · ${c.accountName}` : ''}
        </ItemDescription>
        {c.lastError && (
          <p className="text-sm text-destructive">
            {t.has(`errors.${c.lastError}`) ? t(`errors.${c.lastError}`) : t('errors.unknown')}
          </p>
        )}
      </ItemContent>
      <ItemActions className="flex-wrap">
        <Button asChild variant="outline" size="sm">
          <Link href={`/settings/jira/${c.id}`}>
            <LayoutGrid />
            {t('boards')}
          </Link>
        </Button>
        {canManage && (
          <form action={retestJiraConnectionAction.bind(null, c.id)}>
            <Button variant="outline" size="sm">
              {t('retest')}
            </Button>
          </form>
        )}
        {canManage && (
          <ConfirmDeleteButton
            onConfirm={deleteJiraConnectionAction.bind(null, c.id)}
            labels={{
              trigger: t('delete'),
              title: t('deleteTitle'),
              description: t('deleteDescription', { name: c.name }),
              confirm: t('delete'),
              cancel: t('cancel'),
            }}
          />
        )}
      </ItemActions>
    </Item>
  );
}
```

`apps/web/src/components/page-breadcrumb.tsx`:
```diff
diff --git a/apps/web/src/components/page-breadcrumb.tsx b/apps/web/src/components/page-breadcrumb.tsx
--- a/apps/web/src/components/page-breadcrumb.tsx
+++ b/apps/web/src/components/page-breadcrumb.tsx
@@ -11,15 +11,25 @@ import {
   BreadcrumbSeparator,
 } from '@/components/ui/breadcrumb';
 
-const TRAILS: Record<string, ('dashboard' | 'settings' | 'jira' | 'llm')[]> = {
+type Crumb = 'dashboard' | 'settings' | 'jira' | 'llm' | 'boards' | 'board';
+
+const TRAILS: Record<string, Crumb[]> = {
   '/': ['dashboard'],
   '/settings/jira': ['settings', 'jira'],
   '/settings/llm': ['settings', 'llm'],
 };
 
+/** Exact pages first, then the dynamic ones (/settings/jira/<id>, /boards/<id>). */
+function trailFor(pathname: string): Crumb[] {
+  if (TRAILS[pathname]) return TRAILS[pathname];
+  if (pathname.startsWith('/settings/jira/')) return ['settings', 'jira', 'boards'];
+  if (pathname.startsWith('/boards/')) return ['dashboard', 'board'];
+  return [];
+}
+
 export function PageBreadcrumb() {
   const t = useTranslations('nav');
-  const trail = TRAILS[usePathname()] ?? [];
+  const trail = trailFor(usePathname());
   return (
     <Breadcrumb>
       <BreadcrumbList>
```

Deep-merge into `apps/web/messages/en.json`:
```json
{
  "nav": {
    "boards": "Boards",
    "board": "Board"
  },
  "jira": {
    "boards": "Boards"
  },
  "boards": {
    "description": "Choose the boards to sync and how their statuses map to To do, In progress and Done.",
    "load": "Load boards from Jira",
    "refresh": "Refresh boards",
    "empty": "No boards loaded yet.",
    "emptyHint": "Load the boards this connection can see in Jira.",
    "selectionTitle": "Boards to sync",
    "selectionDescription": "Selected boards are synced every few minutes and get dashboards.",
    "saveSelection": "Save selection",
    "selectionSaved": "Board selection saved.",
    "estimates": {
      "points": "Story points",
      "count": "Issue count"
    },
    "types": {
      "scrum": "Scrum",
      "kanban": "Kanban",
      "simple": "Simple"
    },
    "mappingTitle": "{board}: status mapping",
    "mappingDescription": "Suggested from Jira's status categories. Mark in-progress statuses where work waits (blocked, waiting for review) so flow efficiency counts them as waiting time.",
    "mappingColumns": {
      "status": "Jira status",
      "jiraCategory": "Jira category",
      "mapsTo": "Counts as",
      "waiting": "Waiting"
    },
    "categories": {
      "todo": "To do",
      "in_progress": "In progress",
      "done": "Done"
    },
    "jiraCategories": {
      "new": "To Do",
      "indeterminate": "In Progress",
      "done": "Done",
      "undefined": "Unknown"
    },
    "saveMapping": "Save mapping",
    "mappingSaved": "Status mapping saved.",
    "sync": {
      "now": "Sync now",
      "idle": "Never synced",
      "queued": "Sync queued…",
      "running": "Syncing…",
      "ok": "Synced {when}",
      "error": "Last sync failed",
      "requested": "Sync started.",
      "alreadyQueued": "A sync is already on its way."
    },
    "errors": {
      "invalid_input": "Check the selection and try again.",
      "forbidden_role": "Only workspace owners and admins can change this.",
      "not_found": "Not found. Reload the page.",
      "no_boards": "Select at least one board first.",
      "already_running": "A sync is already running.",
      "blocked_url": "This Jira address is not allowed any more. Ask your administrator.",
      "unauthorized": "Jira rejected the stored credentials. Update the connection.",
      "forbidden": "Jira refused access to these boards.",
      "not_jira": "Jira did not answer as expected.",
      "wrong_deployment": "The Jira type no longer matches this site.",
      "rate_limited": "Jira is busy. The next sync will retry.",
      "unreachable": "Could not reach Jira.",
      "oauth_expired": "Atlassian access expired. Reconnect with Atlassian.",
      "oauth_unavailable": "Atlassian sign-in is not configured on this server.",
      "unknown": "Something went wrong."
    }
  }
}
```

Deep-merge into `apps/web/messages/fr.json`:
```json
{
  "nav": {
    "boards": "Tableaux",
    "board": "Tableau"
  },
  "jira": {
    "boards": "Tableaux"
  },
  "boards": {
    "description": "Choisissez les tableaux à synchroniser et la correspondance de leurs statuts avec À faire, En cours et Terminé.",
    "load": "Charger les tableaux depuis Jira",
    "refresh": "Actualiser les tableaux",
    "empty": "Aucun tableau chargé.",
    "emptyHint": "Chargez les tableaux visibles par cette connexion dans Jira.",
    "selectionTitle": "Tableaux à synchroniser",
    "selectionDescription": "Les tableaux sélectionnés sont synchronisés toutes les quelques minutes et ont leurs tableaux de bord.",
    "saveSelection": "Enregistrer la sélection",
    "selectionSaved": "Sélection des tableaux enregistrée.",
    "estimates": {
      "points": "Points d'effort",
      "count": "Nombre de tickets"
    },
    "types": {
      "scrum": "Scrum",
      "kanban": "Kanban",
      "simple": "Simple"
    },
    "mappingTitle": "{board} : correspondance des statuts",
    "mappingDescription": "Proposée à partir des catégories de statut Jira. Indiquez les statuts en cours où le travail attend (bloqué, en attente de revue) pour que l'efficacité du flux les compte comme de l'attente.",
    "mappingColumns": {
      "status": "Statut Jira",
      "jiraCategory": "Catégorie Jira",
      "mapsTo": "Compte comme",
      "waiting": "Attente"
    },
    "categories": {
      "todo": "À faire",
      "in_progress": "En cours",
      "done": "Terminé"
    },
    "jiraCategories": {
      "new": "À faire",
      "indeterminate": "En cours",
      "done": "Terminé",
      "undefined": "Inconnue"
    },
    "saveMapping": "Enregistrer la correspondance",
    "mappingSaved": "Correspondance des statuts enregistrée.",
    "sync": {
      "now": "Synchroniser",
      "idle": "Jamais synchronisé",
      "queued": "Synchronisation en file…",
      "running": "Synchronisation…",
      "ok": "Synchronisé {when}",
      "error": "La dernière synchronisation a échoué",
      "requested": "Synchronisation lancée.",
      "alreadyQueued": "Une synchronisation est déjà prévue."
    },
    "errors": {
      "invalid_input": "Vérifiez la sélection et réessayez.",
      "forbidden_role": "Seuls les propriétaires et administrateurs de l'espace peuvent modifier ceci.",
      "not_found": "Introuvable. Rechargez la page.",
      "no_boards": "Sélectionnez d'abord au moins un tableau.",
      "already_running": "Une synchronisation est déjà en cours.",
      "blocked_url": "Cette adresse Jira n'est plus autorisée. Contactez votre administrateur.",
      "unauthorized": "Jira a refusé les identifiants enregistrés. Mettez à jour la connexion.",
      "forbidden": "Jira refuse l'accès à ces tableaux.",
      "not_jira": "Jira n'a pas répondu comme prévu.",
      "wrong_deployment": "Le type de Jira ne correspond plus à ce site.",
      "rate_limited": "Jira est occupé. La prochaine synchronisation réessaiera.",
      "unreachable": "Impossible de joindre Jira.",
      "oauth_expired": "L'accès Atlassian a expiré. Reconnectez-vous avec Atlassian.",
      "oauth_unavailable": "La connexion Atlassian n'est pas configurée sur ce serveur.",
      "unknown": "Une erreur s'est produite."
    }
  }
}
```

Check EN/FR parity:
```bash
node -e "const k=(o,p='')=>Object.entries(o).flatMap(([x,v])=>typeof v==='object'?k(v,p+x+'.'):[p+x]);const en=new Set(k(require('./apps/web/messages/en.json'))),fr=new Set(k(require('./apps/web/messages/fr.json')));console.log([...en].filter(x=>!fr.has(x)),[...fr].filter(x=>!en.has(x)))"
```
Expected: `[] []`.

- [ ] **Step 5: Run lint, typecheck, build, e2e**

Run:
```bash
pnpm lint && pnpm typecheck
pnpm --filter @agile/web build
CI=true pnpm e2e
```
Expected: clean; the build lists `ƒ /settings/jira/[connectionId]` and `.next/standalone/node_modules/.pnpm` contains `pg-boss@12.36.0…`; all e2e tests pass, including "select boards, map statuses and sync them" (the worker runs the sync; the page shows "Synced …").

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): board selection, status mapping and Sync now for Jira connections

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Web — default Scrum and Kanban dashboards (shadcn `dashboard-01` + `chart`)

**Files:**
- Create (shadcn): `apps/web/src/components/ui/{chart,tabs}.tsx` via `shadcn add` (adds `recharts@3.8.0`)
- Create: `apps/web/src/components/dashboard/{types.ts,kpi-cards.tsx,widget-chart.tsx,widget-table.tsx,widget-card.tsx,dashboard-view.tsx}`, `apps/web/src/app/(app)/boards/[boardId]/page.tsx`
- Modify: `apps/web/package.json`, `apps/web/next.config.ts`, `apps/web/src/app/(app)/page.tsx` (boards list + "Choose boards" step), `apps/web/src/app/(app)/layout.tsx` (wider `@container/main`), `apps/web/src/app/(app)/settings/{jira,llm}/page.tsx` (keep their 4xl width), `apps/web/messages/{en,fr}.json`
- Test: `e2e/tests/sync-dashboards.spec.ts` (full)

**Interfaces:**
- `/boards/<boardId>` (selected boards only, else 404): seeds the user's default dashboards, loads the dataset once, computes every widget on the server (`computeWidget(spec, dataset, new Date())`), renders one shadcn `Tabs` tab per dashboard ("Sprint", "Flow"), each a `DashboardView`; no data yet → an `Empty` state linking to the board settings.
- `DashboardView({ widgets: RenderedWidget[] })` — the `dashboard-01` layout: `KpiCards` (adapted `SectionCards`) for `chart: 'kpi'`, then a responsive grid of `WidgetCard`s (`WidgetChart` — bar/line/area with `ChartContainer`, `ChartTooltip`, `ChartLegend`, adapted from `ChartAreaInteractive` — or `WidgetTable`, or the empty reason). Every widget carries `data-widget="<id>"`; a KPI's value is its `[data-slot="card-title"]`.
- Formatting: KPI values with `next-intl` (`percent` → `95%`; others through `dashboards.units.*`, e.g. `19 pts`, `1 issue`, `8 days`, `3 / week`); dates in UTC; metric titles interpolate the widget params (`How many in the next {days} days?`).
- Home: "Your boards" (links to the dashboards) above "Get started", which gains "Choose boards to sync".

**Ruling — dashboard-01 is adapted, not installed wholesale.** `shadcn add dashboard-01` would overwrite our `sidebar-07`-based `app-sidebar.tsx`, `nav-main.tsx`, `nav-user.tsx` and `use-mobile.ts`, and add demo data plus `@dnd-kit/*`, `@tanstack/react-table` and `vaul` for a sortable data table we do not use. We install its primitives (`chart`, `tabs`, alongside `card`/`badge`/`table` we have) and adapt its `section-cards.tsx` and `chart-area-interactive.tsx` (inspect them with `pnpm --filter @agile/web exec shadcn add dashboard-01 --view src/components/section-cards.tsx` and `--view src/components/chart-area-interactive.tsx`) into `kpi-cards.tsx` and `widget-chart.tsx`, keeping their classes. Cost if wrong: none functionally; a later `shadcn` upgrade of the block has to be merged by hand.

- [ ] **Step 1: Failing e2e (part 2: dashboards)**

Replace `e2e/tests/sync-dashboards.spec.ts` with the full test (same first part, then both dashboards):
```ts
import { expect, type Page, test } from '@playwright/test';
import { connectionItem, signUpWithWorkspace } from '../helpers';

// The mock Jira serves the demo dataset (packages/jira/src/testing/demo-dataset.ts); the numbers
// below are the ones it is built to produce.
test.describe.configure({ timeout: 180_000 });

async function connectDemoJira(page: Page) {
  await page.goto('/settings/jira');
  await page.getByLabel('Connection name').fill('Demo Jira');
  await page.getByLabel('Jira URL').fill('http://127.0.0.1:4010');
  await page.getByLabel('Data Center / Server').check();
  await page.getByLabel('Personal access token').fill('good-pat');
  await page.getByRole('button', { name: 'Test and save' }).click();
  await expect(connectionItem(page, 'Demo Jira').getByText('Connected')).toBeVisible();
}

const kpi = (page: Page, id: string) =>
  page.locator(`[data-widget="${id}"] [data-slot="card-title"]`);
// The first visit of a route makes `next dev` compile it (recharts, pg-boss…), which can be slow.
const firstCompile = { timeout: 60_000 };

test('select boards, map statuses, sync, and read the Scrum and Kanban dashboards', async ({
  page,
}) => {
  await signUpWithWorkspace(page);
  await connectDemoJira(page);

  // Boards
  await connectionItem(page, 'Demo Jira').getByRole('link', { name: 'Boards' }).click();
  await expect(page.getByText('No boards loaded yet.')).toBeVisible(firstCompile);
  await page.getByRole('button', { name: 'Load boards from Jira' }).click();
  await page.getByLabel('DEMO Scrum').check();
  await page.getByLabel('OPS Kanban').check();
  await page.getByRole('button', { name: 'Save selection' }).click();
  await expect(page.getByText('Board selection saved.')).toBeVisible();

  // Status mapping, suggested from Jira's categories ("Blocked" is a waiting state)
  const scrumMapping = page.locator('[data-board="DEMO Scrum"]');
  const blocked = scrumMapping.locator('[data-status="Blocked"]');
  await expect(blocked.getByRole('combobox')).toHaveValue('in_progress');
  await expect(blocked.getByRole('checkbox')).toBeChecked();
  const review = scrumMapping.locator('[data-status="In Review"]');
  await review.getByRole('checkbox').check();
  await scrumMapping.getByRole('button', { name: 'Save mapping' }).click();
  await expect(page.getByText('Status mapping saved.')).toBeVisible();
  // Undo it so the dashboard numbers below match the default mapping.
  await page
    .locator('[data-board="DEMO Scrum"] [data-status="In Review"]')
    .getByRole('checkbox')
    .uncheck();
  await page
    .locator('[data-board="DEMO Scrum"]')
    .getByRole('button', { name: 'Save mapping' })
    .click();

  // Sync (runs in the worker)
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByText(/^Synced /)).toBeVisible({ timeout: 90_000 });

  // Scrum dashboard
  await page.goto('/');
  await page.getByRole('link', { name: /DEMO Scrum/ }).click();
  await expect(page.getByRole('heading', { name: 'DEMO Scrum' })).toBeVisible(firstCompile);
  await expect(kpi(page, 'avg-velocity')).toHaveText('19 pts');
  await expect(kpi(page, 'say-do')).toHaveText('95%');
  await expect(kpi(page, 'scope-added')).toHaveText('2 pts');
  await expect(kpi(page, 'carry-over')).toHaveText('1 issue');
  await expect(
    page.locator('[data-widget="velocity"] .recharts-bar-rectangle').first(),
  ).toBeVisible();
  await expect(page.locator('[data-widget="burndown"] .recharts-line').first()).toBeVisible();

  // The flow dashboard of the same board
  await page.getByRole('tab', { name: 'Flow' }).click();
  await expect(
    page.locator('[data-widget="throughput"] .recharts-bar-rectangle').first(),
  ).toBeVisible();

  // Kanban dashboard
  await page.goto('/');
  await page.getByRole('link', { name: /OPS Kanban/ }).click();
  await expect(page.getByRole('tab')).toHaveText(['Flow']);
  await expect(kpi(page, 'throughput-rate')).toHaveText('3 / week');
  await expect(kpi(page, 'cycle-time')).toHaveText('8 days');
  await expect(kpi(page, 'wip')).toHaveText('4 issues');
  await expect(kpi(page, 'flow-efficiency')).toHaveText('83%');
  await expect(page.locator('[data-widget="cfd"] .recharts-area').first()).toBeVisible();
  await expect(page.locator('[data-widget="aging-wip"] tbody tr')).toHaveCount(4);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `CI=true pnpm e2e --grep "Kanban dashboards"`
Expected: FAIL — after "Synced", the home page has no `DEMO Scrum` link.

- [ ] **Step 3: shadcn components and dependencies**

Run:
```bash
pnpm --filter @agile/web exec shadcn add chart tabs --yes
pnpm --filter @agile/web add '@agile/dashboards@workspace:*' '@agile/metrics@workspace:*'
```
Expected: `src/components/ui/chart.tsx` and `tabs.tsx` created; `apps/web/package.json` gains `"recharts": "3.8.0"` (exact — shadcn's chart registry pins it), `"@agile/dashboards"` and `"@agile/metrics"`.

`apps/web/next.config.ts` — add the two packages to `transpilePackages`:
```ts
  transpilePackages: [
    '@agile/auth',
    '@agile/config',
    '@agile/connections',
    '@agile/crypto',
    '@agile/dashboards',
    '@agile/db',
    '@agile/jira',
    '@agile/llm',
    '@agile/metrics',
    '@agile/net',
    '@agile/sync',
  ],
```

- [ ] **Step 4: Widget components (adapted from dashboard-01)**

`apps/web/src/components/dashboard/types.ts`:
```ts
import type { WidgetData, WidgetSpec } from '@agile/dashboards';

/** A widget spec with its computed data, ready to render. */
export interface RenderedWidget {
  spec: WidgetSpec;
  data: WidgetData;
}

export type SeriesData = Extract<WidgetData, { kind: 'series' }>;
export type TableData = Extract<WidgetData, { kind: 'table' }>;
```

`apps/web/src/components/dashboard/kpi-cards.tsx` (from `section-cards.tsx`):
```tsx
import { getFormatter, getTranslations } from 'next-intl/server';
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import type { RenderedWidget } from './types';

/** KPI row, adapted from the shadcn dashboard-01 block's SectionCards. */
export async function KpiCards({ widgets }: { widgets: RenderedWidget[] }) {
  const t = await getTranslations('dashboards');
  const format = await getFormatter();

  const value = ({ data }: RenderedWidget): string => {
    if (data.kind !== 'kpi' || data.value === null) return '—';
    if (data.format === 'percent') {
      return format.number(data.value, { style: 'percent', maximumFractionDigits: 0 });
    }
    return t(`units.${data.format}`, {
      count: data.value,
      value: format.number(data.value, { maximumFractionDigits: 1 }),
    });
  };
  const hint = ({ data }: RenderedWidget): string | null => {
    if (data.kind === 'empty') return t(`empty.${data.reason}`);
    if (data.kind === 'kpi' && data.hint)
      return t(`hints.${data.hint.key}`, data.hint.values ?? {});
    return null;
  };

  return (
    <div className="grid grid-cols-1 gap-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card">
      {widgets.map((w) => (
        <Card key={w.spec.id} className="@container/card" data-widget={w.spec.id}>
          <CardHeader>
            <CardDescription>
              {w.spec.title ?? t(`metrics.${w.spec.metric}.title`, w.spec.params)}
            </CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
              {value(w)}
            </CardTitle>
          </CardHeader>
          <CardFooter className="flex-col items-start gap-1.5 text-sm">
            <div className="text-muted-foreground">{hint(w)}</div>
          </CardFooter>
        </Card>
      ))}
    </div>
  );
}
```

`apps/web/src/components/dashboard/widget-chart.tsx` (from `chart-area-interactive.tsx`):
```tsx
'use client';

import { useFormatter } from 'next-intl';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from 'recharts';
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import type { SeriesData } from './types';

// Theme chart colours, ordered for contrast against the card background.
const PALETTE = [2, 4, 1, 3, 5];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Bar/line/area chart for a series widget, adapted from the dashboard-01 interactive area chart. */
export function WidgetChart({
  data,
  labels,
}: {
  data: SeriesData;
  labels: Record<string, string>;
}) {
  const format = useFormatter();
  const config = Object.fromEntries(
    data.series.map((s, i) => [
      s.key,
      { label: labels[s.key] ?? s.key, color: `var(--chart-${PALETTE[i % PALETTE.length]})` },
    ]),
  ) satisfies ChartConfig;
  const tick = (value: unknown) => {
    const text = String(value);
    return DAY.test(text)
      ? format.dateTime(new Date(`${text}T00:00:00Z`), {
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        })
      : text;
  };
  const axes = [
    <CartesianGrid key="grid" vertical={false} />,
    <XAxis
      key="x"
      dataKey={data.x}
      tickLine={false}
      axisLine={false}
      tickMargin={8}
      minTickGap={24}
      tickFormatter={tick}
    />,
    <YAxis key="y" tickLine={false} axisLine={false} width={32} allowDecimals={false} />,
    <ChartTooltip
      key="tooltip"
      cursor={false}
      content={<ChartTooltipContent labelFormatter={(label) => tick(label)} indicator="dot" />}
    />,
    <ChartLegend key="legend" content={<ChartLegendContent />} />,
  ];

  return (
    <ChartContainer config={config} className="aspect-auto h-[250px] w-full">
      {data.chart === 'bar' ? (
        <BarChart data={data.rows}>
          {axes}
          {data.series.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              fill={`var(--color-${s.key})`}
              radius={4}
              stackId={s.stacked ? 'stack' : undefined}
            />
          ))}
        </BarChart>
      ) : data.chart === 'line' ? (
        <LineChart data={data.rows}>
          {axes}
          {data.series.map((s) => (
            <Line
              key={s.key}
              dataKey={s.key}
              type="monotone"
              stroke={`var(--color-${s.key})`}
              strokeWidth={2}
              strokeDasharray={s.dashed ? '4 4' : undefined}
              dot={false}
            />
          ))}
        </LineChart>
      ) : (
        <AreaChart data={data.rows}>
          {axes}
          {data.series.map((s) => (
            <Area
              key={s.key}
              dataKey={s.key}
              type="monotone"
              fill={`var(--color-${s.key})`}
              fillOpacity={0.4}
              stroke={`var(--color-${s.key})`}
              stackId={s.stacked ? 'stack' : undefined}
            />
          ))}
        </AreaChart>
      )}
    </ChartContainer>
  );
}
```

`apps/web/src/components/dashboard/widget-table.tsx`:
```tsx
import { getFormatter, getTranslations } from 'next-intl/server';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { TableData } from './types';

const MAX_ROWS = 20;

export async function WidgetTable({ data }: { data: TableData }) {
  const t = await getTranslations('dashboards');
  const format = await getFormatter();
  const cell = (value: string | number | null, type: TableData['columns'][number]['type']) => {
    if (value === null) return '—';
    switch (type) {
      case 'days':
        return t('units.days', {
          count: Number(value),
          value: format.number(Number(value), { maximumFractionDigits: 1 }),
        });
      case 'number':
        return format.number(Number(value));
      case 'date':
        return format.dateTime(new Date(`${value}T00:00:00Z`), {
          dateStyle: 'medium',
          timeZone: 'UTC',
        });
      case 'code':
        return t(`codes.${value}`);
      case 'codes':
        return String(value)
          .split(',')
          .map((c) => t(`codes.${c}`))
          .join(', ');
      default:
        return String(value);
    }
  };
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {data.columns.map((c) => (
            <TableHead key={c.key}>{t(`columns.${c.key}`)}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.rows.slice(0, MAX_ROWS).map((row) => (
          <TableRow key={String(row[0])}>
            {data.columns.map((c, j) => (
              <TableCell
                key={c.key}
                className={c.key === 'summary' ? 'max-w-64 truncate' : undefined}
              >
                {cell(row[j] ?? null, c.type)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
```

`apps/web/src/components/dashboard/widget-card.tsx`:
```tsx
import { getTranslations } from 'next-intl/server';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { RenderedWidget } from './types';
import { WidgetChart } from './widget-chart';
import { WidgetTable } from './widget-table';

export async function WidgetCard({ widget }: { widget: RenderedWidget }) {
  const t = await getTranslations('dashboards');
  const { spec, data } = widget;
  return (
    <Card data-widget={spec.id} className="@container/card">
      <CardHeader>
        <CardTitle>{spec.title ?? t(`metrics.${spec.metric}.title`, spec.params)}</CardTitle>
        <CardDescription>{t(`metrics.${spec.metric}.description`)}</CardDescription>
      </CardHeader>
      <CardContent className="px-2 sm:px-6">
        {data.kind === 'series' && (
          <WidgetChart
            data={data}
            labels={Object.fromEntries(data.series.map((s) => [s.key, t(`series.${s.key}`)]))}
          />
        )}
        {data.kind === 'table' && <WidgetTable data={data} />}
        {data.kind === 'empty' && (
          <p className="text-sm text-muted-foreground">{t(`empty.${data.reason}`)}</p>
        )}
      </CardContent>
    </Card>
  );
}
```

`apps/web/src/components/dashboard/dashboard-view.tsx`:
```tsx
import { KpiCards } from './kpi-cards';
import type { RenderedWidget } from './types';
import { WidgetCard } from './widget-card';

/** dashboard-01 layout: KPI cards on top, then the chart and table widgets in a responsive grid. */
export function DashboardView({ widgets }: { widgets: RenderedWidget[] }) {
  const kpis = widgets.filter((w) => w.spec.chart === 'kpi');
  const others = widgets.filter((w) => w.spec.chart !== 'kpi');
  return (
    <div className="flex flex-col gap-4 md:gap-6">
      {kpis.length > 0 && <KpiCards widgets={kpis} />}
      <div className="grid grid-cols-1 gap-4 @4xl/main:grid-cols-2">
        {others.map((w) => (
          <WidgetCard key={w.spec.id} widget={w} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Pages, layout and messages**

`apps/web/src/app/(app)/boards/[boardId]/page.tsx`:
```tsx
import {
  computeWidget,
  ensureDefaultDashboards,
  listDashboards,
  loadBoardDataset,
} from '@agile/dashboards';
import { getBoard } from '@agile/sync';
import { RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { DashboardView } from '@/components/dashboard/dashboard-view';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { requireActor, services } from '@/server/context';
import { syncDeps } from '@/server/sync';

export default async function BoardDashboardPage({
  params,
}: {
  params: Promise<{ boardId: string }>;
}) {
  const actor = await requireActor();
  const { boardId } = await params;
  if (!z.uuid().safeParse(boardId).success) notFound();
  const board = await getBoard(syncDeps(), actor.orgId, boardId);
  if (!board?.selected) notFound();

  const { db } = services();
  const t = await getTranslations('dashboards');
  const format = await getFormatter();
  await ensureDefaultDashboards(db, actor.orgId, actor.userId, board);
  const [dashboards, dataset] = await Promise.all([
    listDashboards(db, actor.orgId, actor.userId, board.id),
    loadBoardDataset(db, actor.orgId, board.id),
  ]);
  const now = new Date();

  const header = (
    <div className="grid gap-1">
      <h1 className="text-2xl font-semibold tracking-tight">{board.name}</h1>
      <p className="text-muted-foreground">
        {board.lastSyncedAt
          ? t('lastSynced', { when: format.relativeTime(board.lastSyncedAt, now) })
          : t('neverSynced')}
      </p>
    </div>
  );

  if (!dataset || dataset.issues.length === 0) {
    return (
      <div className="grid gap-6">
        {header}
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RefreshCw />
            </EmptyMedia>
            <EmptyTitle>{t('noData')}</EmptyTitle>
            <EmptyDescription>{t('noDataHint')}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild variant="outline">
              <Link href={`/settings/jira/${board.connectionId}`}>{t('openSettings')}</Link>
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  const views = dashboards.map((d) => ({
    id: d.id,
    label: d.kind === 'custom' ? d.name : t(`kinds.${d.kind}`),
    widgets: d.widgets.map((spec) => ({ spec, data: computeWidget(spec, dataset, now) })),
  }));
  return (
    <div className="grid gap-6">
      {header}
      <Tabs defaultValue={views[0]?.id}>
        <TabsList>
          {views.map((v) => (
            <TabsTrigger key={v.id} value={v.id}>
              {v.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {views.map((v) => (
          <TabsContent key={v.id} value={v.id} className="mt-4">
            <DashboardView widgets={v.widgets} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
```

`apps/web/src/app/(app)/page.tsx`:
```tsx
import { listJiraConnections, listLlmConnections } from '@agile/connections';
import { listSelectedBoards } from '@agile/sync';
import { Bot, ChartColumn, LayoutGrid, PlugZap } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Badge } from '@/components/ui/badge';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { connectionDeps, requireActor } from '@/server/context';
import { syncDeps } from '@/server/sync';

export default async function DashboardPage() {
  const actor = await requireActor();
  const t = await getTranslations('dashboard');
  const tb = await getTranslations('boards');
  const deps = connectionDeps();
  const [jira, llm, boards] = await Promise.all([
    listJiraConnections(deps, actor.orgId),
    listLlmConnections(deps, actor.orgId),
    listSelectedBoards(syncDeps(), actor.orgId),
  ]);
  const firstJira = jira.find((c) => c.status === 'ok');
  const steps = [
    {
      href: '/settings/jira',
      icon: PlugZap,
      title: t('connectJira'),
      hint: t('connectJiraHint'),
      done: Boolean(firstJira),
    },
    {
      href: firstJira ? `/settings/jira/${firstJira.id}` : '/settings/jira',
      icon: LayoutGrid,
      title: t('chooseBoards'),
      hint: t('chooseBoardsHint'),
      done: boards.length > 0,
    },
    {
      href: '/settings/llm',
      icon: Bot,
      title: t('connectLlm'),
      hint: t('connectLlmHint'),
      done: llm.some((c) => c.status === 'ok'),
    },
  ];
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-6">
      {boards.length > 0 && (
        <section className="grid gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{t('yourBoards')}</h1>
          <ItemGroup className="gap-3">
            {boards.map((b) => (
              <Item key={b.id} variant="outline" asChild>
                <Link href={`/boards/${b.id}`}>
                  <ItemMedia variant="icon">
                    <ChartColumn />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{b.name}</ItemTitle>
                    <ItemDescription>{b.projectKey}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Badge variant="outline">{tb(`types.${b.type}`)}</Badge>
                  </ItemActions>
                </Link>
              </Item>
            ))}
          </ItemGroup>
        </section>
      )}
      <section className="grid gap-3">
        <h2 className="text-2xl font-semibold tracking-tight">{t('title')}</h2>
        <ItemGroup className="gap-3">
          {steps.map((s) => (
            <Item key={s.title} variant="outline" asChild>
              <Link href={s.href}>
                <ItemMedia variant="icon">
                  <s.icon />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{s.title}</ItemTitle>
                  <ItemDescription>{s.hint}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Badge variant={s.done ? 'default' : 'secondary'}>
                    {s.done ? t('done') : t('todo')}
                  </Badge>
                </ItemActions>
              </Link>
            </Item>
          ))}
        </ItemGroup>
      </section>
    </div>
  );
}
```

Layout and settings widths:
```diff
diff --git a/apps/web/src/app/(app)/layout.tsx b/apps/web/src/app/(app)/layout.tsx
--- a/apps/web/src/app/(app)/layout.tsx
+++ b/apps/web/src/app/(app)/layout.tsx
@@ -22,7 +22,8 @@ export default async function AppLayout({ children }: { children: ReactNode }) {
           </div>
         </header>
         <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
-          <div className="mx-auto w-full max-w-4xl">{children}</div>
+          {/* @container/main: the dashboard grids (dashboard-01) respond to this container's width. */}
+          <div className="@container/main mx-auto w-full max-w-6xl">{children}</div>
         </div>
       </SidebarInset>
     </SidebarProvider>
diff --git a/apps/web/src/app/(app)/settings/jira/page.tsx b/apps/web/src/app/(app)/settings/jira/page.tsx
--- a/apps/web/src/app/(app)/settings/jira/page.tsx
+++ b/apps/web/src/app/(app)/settings/jira/page.tsx
@@ -27,7 +27,7 @@ export default async function JiraSettingsPage({
   const canManage = canManageConnections(actor.roles);
 
   return (
-    <div className="grid gap-6">
+    <div className="mx-auto grid w-full max-w-4xl gap-6">
       <div className="grid gap-1">
         <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
         <p className="text-muted-foreground">{t('description')}</p>
diff --git a/apps/web/src/app/(app)/settings/llm/page.tsx b/apps/web/src/app/(app)/settings/llm/page.tsx
--- a/apps/web/src/app/(app)/settings/llm/page.tsx
+++ b/apps/web/src/app/(app)/settings/llm/page.tsx
@@ -20,7 +20,7 @@ export default async function LlmSettingsPage() {
   const connections = await listLlmConnections(connectionDeps(), actor.orgId);
   const canManage = canManageConnections(actor.roles);
   return (
-    <div className="grid gap-6">
+    <div className="mx-auto grid w-full max-w-4xl gap-6">
       <div className="grid gap-1">
         <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
         <p className="text-muted-foreground">{t('intro')}</p>
```

Deep-merge into `apps/web/messages/en.json`:
```json
{
  "dashboard": {
    "chooseBoards": "Choose boards to sync",
    "chooseBoardsHint": "Pick boards, check the status mapping and run a first sync.",
    "yourBoards": "Your boards"
  },
  "dashboards": {
    "lastSynced": "Synced {when}",
    "neverSynced": "Not synced yet",
    "noData": "No data for this board yet",
    "noDataHint": "Run a sync from the board settings; dashboards fill in as soon as it finishes.",
    "openSettings": "Open board settings",
    "kinds": {
      "scrum": "Sprint",
      "kanban": "Flow"
    },
    "metrics": {
      "average_velocity": {
        "title": "Average velocity",
        "description": "Work completed per closed sprint."
      },
      "say_do_ratio": {
        "title": "Say/do ratio",
        "description": "Completed versus committed at sprint start."
      },
      "velocity": {
        "title": "Velocity",
        "description": "Committed at sprint start versus completed at sprint end."
      },
      "scope_change": {
        "title": "Scope added",
        "description": "Work added to the sprint after it started."
      },
      "carry_over": {
        "title": "Carried over",
        "description": "Issues still open when the last sprint closed."
      },
      "sprint_burndown": {
        "title": "Sprint burndown",
        "description": "Work remaining each day against the ideal line."
      },
      "sprint_burnup": {
        "title": "Sprint burnup",
        "description": "Work completed each day against the sprint scope."
      },
      "cycle_time": {
        "title": "Cycle time",
        "description": "Days from start to done (85th percentile)."
      },
      "lead_time": {
        "title": "Lead time",
        "description": "Days from creation to done."
      },
      "throughput": {
        "title": "Weekly throughput",
        "description": "Issues finished each week."
      },
      "throughput_rate": {
        "title": "Throughput",
        "description": "Issues finished per week, recent average."
      },
      "wip": {
        "title": "Work in progress",
        "description": "Issues in progress right now."
      },
      "wip_trend": {
        "title": "Work in progress over time",
        "description": "Issues in progress at the end of each day."
      },
      "aging_wip": {
        "title": "Aging work in progress",
        "description": "How long each in-progress issue has been going."
      },
      "cfd": {
        "title": "Cumulative flow",
        "description": "Issues per workflow stage, day by day."
      },
      "flow_efficiency": {
        "title": "Flow efficiency",
        "description": "Share of cycle time not spent blocked or waiting."
      },
      "forecast_how_many": {
        "title": "How many in the next {days} days?",
        "description": "Monte Carlo forecast from recent throughput."
      },
      "forecast_when": {
        "title": "When will the next {items} be done?",
        "description": "Monte Carlo forecast from recent throughput."
      },
      "hygiene": {
        "title": "Needs attention",
        "description": "Stale, unestimated, unassigned or oversized open issues."
      }
    },
    "series": {
      "committed": "Committed",
      "completed": "Completed",
      "remaining": "Remaining",
      "ideal": "Ideal",
      "scope": "Scope",
      "done": "Done",
      "wip": "In progress",
      "todo": "To do",
      "inProgress": "In progress"
    },
    "columns": {
      "percentile": "Percentile",
      "days": "Days",
      "key": "Issue",
      "summary": "Summary",
      "age": "Age",
      "status": "Status",
      "confidence": "Confidence",
      "items": "At least",
      "date": "By",
      "problems": "Problems"
    },
    "codes": {
      "blocked": "Blocked",
      "late": "Older than usual",
      "on_track": "On track",
      "stale": "Not updated for 2 weeks",
      "missing_estimate": "No estimate",
      "unassigned_in_progress": "In progress, unassigned",
      "oversized": "Too big"
    },
    "units": {
      "points": "{value} pts",
      "issues": "{count, plural, one {{value} issue} other {{value} issues}}",
      "days": "{count, plural, one {{value} day} other {{value} days}}",
      "per_week": "{value} / week",
      "number": "{value}",
      "percent": "{value}"
    },
    "hints": {
      "lastSprints": "Last {count, plural, one {sprint} other {# sprints}}",
      "scopeRemoved": "{removed} removed · {sprint}",
      "carriedFrom": "Not finished in {sprint}",
      "finishedIn": "{count} finished in the last {days} days",
      "lastDays": "Last {days} days",
      "blockedDays": "{days} days blocked or waiting"
    },
    "empty": {
      "no_sprint": "No sprint to show yet.",
      "no_data": "Not enough data yet.",
      "no_estimates": "This board has no estimates."
    }
  }
}
```

Deep-merge into `apps/web/messages/fr.json`:
```json
{
  "dashboard": {
    "chooseBoards": "Choisir les tableaux à synchroniser",
    "chooseBoardsHint": "Sélectionnez des tableaux, vérifiez la correspondance des statuts et lancez une première synchronisation.",
    "yourBoards": "Vos tableaux"
  },
  "dashboards": {
    "lastSynced": "Synchronisé {when}",
    "neverSynced": "Pas encore synchronisé",
    "noData": "Aucune donnée pour ce tableau",
    "noDataHint": "Lancez une synchronisation depuis les réglages du tableau ; les tableaux de bord se remplissent dès qu'elle se termine.",
    "openSettings": "Ouvrir les réglages du tableau",
    "kinds": {
      "scrum": "Sprint",
      "kanban": "Flux"
    },
    "metrics": {
      "average_velocity": {
        "title": "Vélocité moyenne",
        "description": "Travail terminé par sprint clôturé."
      },
      "say_do_ratio": {
        "title": "Engagement tenu",
        "description": "Terminé par rapport à l'engagement de début de sprint."
      },
      "velocity": {
        "title": "Vélocité",
        "description": "Engagé au début du sprint et terminé à la fin."
      },
      "scope_change": {
        "title": "Périmètre ajouté",
        "description": "Travail ajouté au sprint après son démarrage."
      },
      "carry_over": {
        "title": "Reporté",
        "description": "Tickets encore ouverts à la clôture du dernier sprint."
      },
      "sprint_burndown": {
        "title": "Burndown du sprint",
        "description": "Reste à faire chaque jour face à la courbe idéale."
      },
      "sprint_burnup": {
        "title": "Burnup du sprint",
        "description": "Travail terminé chaque jour face au périmètre du sprint."
      },
      "cycle_time": {
        "title": "Temps de cycle",
        "description": "Jours entre le démarrage et la fin (85e centile)."
      },
      "lead_time": {
        "title": "Délai de livraison",
        "description": "Jours entre la création et la fin."
      },
      "throughput": {
        "title": "Débit hebdomadaire",
        "description": "Tickets terminés chaque semaine."
      },
      "throughput_rate": {
        "title": "Débit",
        "description": "Tickets terminés par semaine, moyenne récente."
      },
      "wip": {
        "title": "En cours",
        "description": "Tickets en cours en ce moment."
      },
      "wip_trend": {
        "title": "En cours dans le temps",
        "description": "Tickets en cours à la fin de chaque jour."
      },
      "aging_wip": {
        "title": "Âge du travail en cours",
        "description": "Depuis combien de temps chaque ticket en cours avance."
      },
      "cfd": {
        "title": "Flux cumulé",
        "description": "Tickets par étape du workflow, jour après jour."
      },
      "flow_efficiency": {
        "title": "Efficacité du flux",
        "description": "Part du temps de cycle hors blocage ou attente."
      },
      "forecast_how_many": {
        "title": "Combien dans les {days} prochains jours ?",
        "description": "Prévision Monte-Carlo à partir du débit récent."
      },
      "forecast_when": {
        "title": "Quand les {items} prochains seront-ils terminés ?",
        "description": "Prévision Monte-Carlo à partir du débit récent."
      },
      "hygiene": {
        "title": "À surveiller",
        "description": "Tickets ouverts inactifs, non estimés, non assignés ou trop gros."
      }
    },
    "series": {
      "committed": "Engagé",
      "completed": "Terminé",
      "remaining": "Reste à faire",
      "ideal": "Idéal",
      "scope": "Périmètre",
      "done": "Terminé",
      "wip": "En cours",
      "todo": "À faire",
      "inProgress": "En cours"
    },
    "columns": {
      "percentile": "Centile",
      "days": "Jours",
      "key": "Ticket",
      "summary": "Résumé",
      "age": "Âge",
      "status": "État",
      "confidence": "Confiance",
      "items": "Au moins",
      "date": "D'ici le",
      "problems": "Problèmes"
    },
    "codes": {
      "blocked": "Bloqué",
      "late": "Plus ancien que d'habitude",
      "on_track": "Dans les temps",
      "stale": "Pas mis à jour depuis 2 semaines",
      "missing_estimate": "Sans estimation",
      "unassigned_in_progress": "En cours, non assigné",
      "oversized": "Trop gros"
    },
    "units": {
      "points": "{value} pts",
      "issues": "{count, plural, one {{value} ticket} other {{value} tickets}}",
      "days": "{count, plural, one {{value} jour} other {{value} jours}}",
      "per_week": "{value} / semaine",
      "number": "{value}",
      "percent": "{value}"
    },
    "hints": {
      "lastSprints": "{count, plural, one {Dernier sprint} other {# derniers sprints}}",
      "scopeRemoved": "{removed} retiré(s) · {sprint}",
      "carriedFrom": "Non terminé dans {sprint}",
      "finishedIn": "{count} terminés ces {days} derniers jours",
      "lastDays": "{days} derniers jours",
      "blockedDays": "{days} jours bloqués ou en attente"
    },
    "empty": {
      "no_sprint": "Aucun sprint à afficher.",
      "no_data": "Pas encore assez de données.",
      "no_estimates": "Ce tableau n'a pas d'estimations."
    }
  }
}
```

Re-run the EN/FR parity check from Task 12 Step 4. Expected: `[] []`.

- [ ] **Step 6: Run lint, typecheck, build, e2e**

Run:
```bash
pnpm lint && pnpm typecheck
pnpm --filter @agile/web build
CI=true pnpm e2e
```
Expected: clean; the build lists `ƒ /boards/[boardId]`; all e2e tests pass: the Sprint tab shows `19 pts`, `95%`, `2 pts`, `1 issue` with velocity bars and a burndown line; the Flow tab renders throughput bars; the OPS Kanban board has a single "Flow" tab with `3 / week`, `8 days`, `4 issues`, `83%`, a CFD and four aging items.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): default Scrum and Kanban dashboards from the dashboard-01 block and shadcn charts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Packaging — self-host worker, CI, README (incl. the Jira validation checklist)

**Files:**
- Modify: `docker-compose.selfhost.yml`, `.env.example`, `.gitlab-ci.yml`, `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Self-host: a `worker` service (image target `worker`, `env_file: .env`, `DATABASE_URL` as `app_user`, health check on `/health:8080`, starts after `migrate` succeeds). No published port.
- CI: the `check` stage also runs `pnpm --filter @agile/worker deploy --prod --legacy /tmp/worker-deploy` (what the worker image ships). The e2e jobs need no change: Playwright starts the worker (Task 12), which migrates with `DATABASE_OWNER_URL` (GitLab sets it; GitHub uses the default on 5433).

- [ ] **Step 1: Compose, env example, CI**

```diff
diff --git a/docker-compose.selfhost.yml b/docker-compose.selfhost.yml
--- a/docker-compose.selfhost.yml
+++ b/docker-compose.selfhost.yml
@@ -1,4 +1,5 @@
 # Usage: cp .env.example .env (fill secrets), then: docker compose -f docker-compose.selfhost.yml up -d --build
+# Services: postgres, migrate (one-shot), web (the app) and worker (Jira sync jobs).
 # Set WEB_PORT in .env to publish the app on a port other than 3000 (and match BETTER_AUTH_URL).
 services:
   postgres:
@@ -36,5 +37,19 @@ services:
       start_period: 20s
       retries: 3
     depends_on: { migrate: { condition: service_completed_successfully } }
+  worker:
+    build: { context: ., dockerfile: apps/web/Dockerfile, target: worker }
+    restart: unless-stopped
+    env_file: .env
+    environment:
+      DATABASE_URL: postgres://app_user:${APP_DB_PASSWORD}@postgres:5432/agile
+      WORKER_HEALTH_PORT: "8080"
+    healthcheck:
+      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1"]
+      interval: 30s
+      timeout: 5s
+      start_period: 20s
+      retries: 3
+    depends_on: { migrate: { condition: service_completed_successfully } }
 volumes:
   pgdata:
diff --git a/.env.example b/.env.example
--- a/.env.example
+++ b/.env.example
@@ -21,3 +21,8 @@ POSTGRES_PASSWORD=
 APP_DB_PASSWORD=
 # Host port the web container is published on (keep BETTER_AUTH_URL in sync)
 WEB_PORT=3000
+
+# Sync worker (apps/worker): minutes between scheduled Jira syncs (5, 10, 15, 20, 30 or 60)
+SYNC_INTERVAL_MINUTES=15
+# Port of the worker's /health endpoint (inside its container)
+WORKER_HEALTH_PORT=8080
diff --git a/.gitlab-ci.yml b/.gitlab-ci.yml
--- a/.gitlab-ci.yml
+++ b/.gitlab-ci.yml
@@ -32,6 +32,8 @@ check:
     - pnpm typecheck
     - pnpm test
     - pnpm --filter @agile/web build
+    # The worker image is built from this production deploy (see apps/web/Dockerfile, target worker).
+    - pnpm --filter @agile/worker deploy --prod --legacy /tmp/worker-deploy
 
 e2e:
   stage: e2e
diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -19,6 +19,8 @@ jobs:
       - run: pnpm test
       - name: Production build (no env needed)
         run: pnpm --filter @agile/web build
+      - name: Worker production deploy (what the worker image ships)
+        run: pnpm --filter @agile/worker deploy --prod --legacy /tmp/worker-deploy
   e2e:
     runs-on: ubuntu-latest
     services:
```

- [ ] **Step 2: README**

```diff
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,6 +1,6 @@
 # Agile Copilot
 
-Agile Copilot is a dashboard and AI agent for managers running Scrum or Kanban projects in Jira. It aims to give reliable, actionable insight (sprint health, flow, risks, forecasts) without analyst skills: you bring your own LLM key (BYOK), connect Jira (Cloud or Server/Data Center), and personalise the analysis by writing natural-language instructions. The UI is bilingual (English and French). This repository holds the Phase 1 foundation: workspaces and roles, an encrypted Jira connection, per-organisation LLM configuration, and the self-host packaging. See `docs/superpowers/specs/2026-10-03-agile-copilot-design.md` for the full design.
+Agile Copilot is a dashboard and AI agent for managers running Scrum or Kanban projects in Jira. It aims to give reliable, actionable insight (sprint health, flow, risks, forecasts) without analyst skills: you bring your own LLM key (BYOK), connect Jira (Cloud or Server/Data Center), and personalise the analysis by writing natural-language instructions. The UI is bilingual (English and French). This repository holds Phases 1 and 2: workspaces and roles, encrypted Jira and LLM connections, a background worker that syncs Jira boards, sprints and issue history, a deterministic metrics engine, and default Scrum and Kanban dashboards that work without any LLM. See `docs/superpowers/specs/2026-10-03-agile-copilot-design.md` for the full design.
 
 Authentication today is email and password. The plan is to add Keycloak/OIDC single sign-on later, with password login then restricted to admins.
 
@@ -31,14 +31,16 @@ Then:
 
 ```bash
 pnpm db:migrate
-pnpm dev                               # http://localhost:3000
+pnpm dev                               # web on http://localhost:3000 + the sync worker
 ```
 
+`pnpm dev` starts both the web app and the sync worker (`apps/worker`). Run the worker alone with `pnpm --filter @agile/worker dev`; it needs the migrations applied first.
+
 Environment variables are read lazily at request time, so `next build` needs none.
 
 ## Self-hosting
 
-`docker-compose.selfhost.yml` runs Postgres, a one-shot `migrate` service, and the web app.
+`docker-compose.selfhost.yml` runs Postgres, a one-shot `migrate` service, the web app, and the sync worker.
 
 ```bash
 cp .env.example .env
@@ -48,7 +50,7 @@ cp .env.example .env
 docker compose -f docker-compose.selfhost.yml up -d --build
 ```
 
-The `migrate` service connects as the database owner and must exit 0 before `web` starts; the web container connects as the non-owner `app_user` role so row-level security applies. The app is published on `${WEB_PORT:-3000}`; if you change it, update `BETTER_AUTH_URL` to match. Put a TLS-terminating reverse proxy in front of it for anything beyond a local trial.
+The `migrate` service connects as the database owner and must exit 0 before `web` and `worker` start; both connect as the non-owner `app_user` role so row-level security applies. The worker has no published port; its health endpoint (`/health` on `WORKER_HEALTH_PORT`, 8080) is used by the container health check. The app is published on `${WEB_PORT:-3000}`; if you change it, update `BETTER_AUTH_URL` to match. Put a TLS-terminating reverse proxy in front of it for anything beyond a local trial.
 
 `POSTGRES_PASSWORD` and `APP_DB_PASSWORD` are inserted unescaped into SQL and into connection URLs, so they must be URL-safe and contain no quotes; generate them with `openssl rand -hex 24`.
 
@@ -79,6 +81,35 @@ To offer "Connect with Atlassian" (OAuth 2.0 3LO) for Jira Cloud:
 
 Without these variables, users can still connect with an API token (Cloud) or a personal access token (Data Center). Note: the OAuth flow has not yet been verified against a real Atlassian tenant. Do a manual check before relying on it.
 
+## Jira sync and dashboards
+
+1. In **Settings → Jira**, open a connection's **Boards**, load the boards, and select the ones to sync.
+2. Check the **status mapping** of each board. Every Jira status counts as *To do*, *In progress* or *Done* (suggested from Jira's status categories). Mark in-progress statuses where work only waits (for example *Blocked* or *Waiting for review*): flow efficiency counts that time as waiting.
+3. Click **Sync now**, or wait for the scheduled sync (every `SYNC_INTERVAL_MINUTES`, default 15). The first sync of a connection reads every issue of the selected boards; later syncs read only issues updated since the previous sync (with a 15-minute overlap), and once a day the worker re-reads everything so that issues which left a board disappear from it.
+4. Open the board from the home page. Scrum boards get a *Sprint* and a *Flow* dashboard; Kanban boards a *Flow* dashboard.
+
+How the numbers are defined:
+
+- **Velocity**: *committed* is what was in the sprint when it started (estimates as of the start); *completed* is what was done when it closed (estimates as of the close), including work added mid-sprint. Boards without an estimation field use issue counts.
+- **Cycle time** runs from the first move to an in-progress status to the final move to done; **lead time** from creation to done. Percentiles use the nearest-rank method.
+- **Flow efficiency** is the share of cycle time not spent in a *waiting* status or flagged as an impediment.
+- **Forecasts** are Monte Carlo simulations (10 000 runs, fixed seed) drawn from the last 30 days of daily throughput.
+- Days are UTC calendar days. Sub-tasks are left out (as in Jira's own reports).
+
+The sync never stores raw Jira error messages: a failed sync shows a short reason (for example *Jira rejected the stored credentials*) and is retried at the next schedule.
+
+## Validating against a real Jira
+
+Automated tests run the same contract against a Cloud-flavoured and a Data Center-flavoured mock Jira (REST v3/`search/jql` with page tokens, REST v2/`search` with offsets, the Agile API, truncated changelogs and HTTP 429). Before relying on a new Jira version, run this checklist once against a real site (a [Data Center trial container](https://hub.docker.com/r/atlassian/jira-software) with a time-bombed licence, and a Jira Cloud sandbox):
+
+1. Connect it (Cloud: API token and "Connect with Atlassian"; Data Center: personal access token). Self-hosted Data Center needs its host in `ALLOWED_PRIVATE_HOSTS`.
+2. Load boards: every Scrum and Kanban board you can see in Jira is listed, with the right type, and Scrum boards show "Story points".
+3. Status mapping: every column status appears, with a sensible suggestion.
+4. Select one Scrum and one Kanban board and click **Sync now**. In Jira, run the board's filter (`filter = <id>` in issue search): the number of issues matches the board's dashboards' data, and the closed sprints match the sprint report's committed/completed values for a sprint with no mid-sprint estimate changes.
+5. Move an issue to another status in Jira, wait for the next scheduled sync (or click **Sync now**), and check that cycle time / WIP change accordingly.
+6. With a board of more than 100 issues, check that all of them were read (pagination) and that an issue with more than 100 changelog entries has its full history.
+7. Note the Jira version and the date in the pull request that validated it.
+
 ## Rotating the encryption key
 
 `ENCRYPTION_KEYS` is a comma-separated list of versioned 32-byte keys. To rotate, append `v2:<new base64 key>` and restart. New organisation keys are wrapped with v2; existing ones still decrypt with v1, so keep v1 in the list. A re-wrap command to retire old versions is not available yet (planned for Phase 5).
@@ -93,7 +124,7 @@ Without these variables, users can still connect with an API token (Cloud) or a
 
 ### Known limitations
 
-- DNS rebinding between the outbound-URL check and the actual connection is not yet pinned (planned for Phase 3).
+- DNS rebinding between the outbound-URL check and the actual connection is not yet pinned (planned for Phase 3). The sync re-checks the outbound URL policy before every run.
 - The key-rotation re-wrap command does not exist yet (Phase 5).
 
 ## Development
@@ -105,4 +136,4 @@ pnpm lint        # Biome
 pnpm typecheck
 ```
 
-Docker is required for tests because the database tests start Postgres through Testcontainers. The e2e suite runs the web app on port 3200 against Postgres on 5433, with local mock Jira and LLM servers.
+Docker is required for tests because the database tests start Postgres through Testcontainers. The e2e suite runs the web app on port 3200 and the sync worker (health on 4030) against Postgres on 5433, with local mock Jira (4010, serving a demo dataset) and LLM (4020) servers. The first visit of each page makes `next dev` compile it; if a cold run times out, run it again (CI uses longer timeouts: `CI=true pnpm e2e`).
```

- [ ] **Step 3: Verify the packaging**

Run:
```bash
POSTGRES_PASSWORD=x APP_DB_PASSWORD=y docker compose -f docker-compose.selfhost.yml config --services
pnpm --filter @agile/worker deploy --prod --legacy /tmp/worker-deploy && ls /tmp/worker-deploy/node_modules/@agile
docker build -f apps/web/Dockerfile --target worker -t agile-worker:dev .
docker build -f apps/web/Dockerfile --target runner -t agile-web:dev .
```
Expected: services `postgres`, `migrate`, `web`, `worker`; the deploy contains `config crypto db jira sync`; both images build.

(`docker compose … config` also reads the services' `env_file: .env`; the repo-root `.env` from the Quick start is enough — it is git-ignored, never commit it.)

- [ ] **Step 4: Full verification**

Run:
```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @agile/web build
CI=true pnpm e2e
```
Expected: Biome and tsc clean; Vitest 34 files / 249 tests pass; the build succeeds; Playwright 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: ship the sync worker in self-host compose and CI; document sync, metrics and Jira validation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Rulings made in this plan

| Ruling | Why | Cost if wrong | Task |
|---|---|---|---|
| Data Center is validated by a two-flavour contract suite against the mock plus a documented manual checklist (real DC trial container + Cloud sandbox) | No DC licence is available; the mock reproduces each API's paging, errors and changelog truncation | A real-DC quirk surfaces only at the first manual run/customer; lenient schemas limit the damage | 6, 14 |
| pg-boss runs as `app_user` in a `pgboss` schema it owns (`createSchema: false`) | The web app must enqueue without owner credentials; RLS tables untouched | A separate queue role would need its own connection string | 1, 9 |
| Incremental window = relative JQL minutes since the last successful sync start + 15 min overlap; full re-read daily | Absolute JQL dates follow the Jira user's time zone; incremental reads cannot see issues leaving a filter | An issue moved off a board lingers ≤ 24 h | 4, 8 |
| Velocity = committed at start (start estimates) vs done at close (close estimates), added scope included | Jira's sprint-report semantics; robust to Jira moving open issues out at close | Small differences from Jira for issues re-added mid-sprint | 2 |
| Nearest-rank percentiles; UTC day buckets; rolling 28-day throughput KPI | Observed values, checkable by hand; no per-org time zone yet | Day boundaries shift for teams far from UTC (per-org zone is a later setting) | 2, 3 |
| Flow efficiency wait = *waiting* statuses ∪ flagged time within the cycle | Jira has no native "blocked" state; both signals are common | Reads ~100% for teams that neither flag nor mark waiting statuses | 3 |
| Sub-tasks excluded, epics included when the filter returns them; unmapped statuses count as to-do | Matches Jira's reports; conservative for unknown statuses | Epics in Kanban filters lengthen cycle times | 11 |
| Widget `title` optional (translated metric name by default) | Default dashboards stay bilingual | Phase 4 must store titles in the user's language | 11 |
| Boards without an estimation field fall back from points to issue counts | Scrum boards can estimate by count | None (explicit in the KPI unit) | 11 |
| `dashboard-01` adapted (primitives + `section-cards`/`chart-area-interactive`), not installed wholesale | The full install overwrites our sidebar-07 files and adds unused dnd-kit/tanstack/vaul and demo data | A future block update is merged by hand | 13 |
| Worker runs TypeScript with tsx (`pnpm deploy --legacy`) | Workspace packages ship TS source; no bundler to maintain | Slower start, ~220 MB deploy | 10 |
| Organisation deletion purges every `org_id` table except `audit_log`, in `beforeDeleteOrganization` | Append-only audit trail, no secrets; failing before deletion never orphans secrets | Deleted workspaces' audit rows stay until Phase 5 retention | 0.4 |
| e2e worker web server migrates before starting | Playwright starts web servers before `globalSetup` | None | 12 |

## Spec coverage (Phase 2)

| Spec requirement | Task |
|---|---|
| Phase 1 review backlog: one `fetchNoRedirect` + one `withDeadline` in `@agile/net`, used by the Jira client, OAuth, probe and LLM | 0.1, 0.2 |
| Jira client: request bodies, caller headers cannot override `Authorization` | 0.2 |
| Delete default LLM → most recent remaining becomes default | 0.3 |
| shadcn `alert-dialog` confirmation before deleting Jira/LLM connections | 0.3 |
| Organisation deletion cleans tenant data (audit_log ruling) | 0.4 |
| Route tests for `/api/jira/oauth/start` and `/callback` (state, workspace binding, role) | 0.5 |
| Normalised tables (`issues`, `issue_transitions`, `sprints`, `sprint_membership`, `boards`), status mappings, board selection, sync state/runs, dashboards — org_id + RLS + FORCE | 1 |
| Worker syncs issues, sprints, boards and status changelogs incrementally (`updated >= lastSync`, overlap), Cloud (jira.js v6) and DC (jira.js v5), redirect-safe | 4, 6, 8 |
| Story points / estimate field detection | 4, 6 (board estimation field), 11 (fallback) |
| Pagination; 429 + Retry-After | 6 |
| OAuth connections through `getFreshJiraCredentials` | 7, 8 |
| Per-connection sync state + last error; manual "Sync now" + scheduled sync (pg-boss 12) | 8, 9, 10, 12 |
| `apps/worker` (pg-boss, cron, graceful stop, health) | 10 |
| Map workflow statuses to To Do / In Progress / Done, auto-suggested from Jira categories, editable; pick boards | 4, 7, 12 |
| Metrics — Scrum: velocity, commitment vs completion, scope change, burndown/burnup, carry-over | 2 |
| Metrics — flow: cycle & lead time percentiles, throughput, WIP, aging WIP, CFD, flow efficiency, blocked time | 3 |
| Forecasting: Monte Carlo "when N done" / "how many by date" at 50/85/95, seeded | 3 |
| Hygiene: stale, missing estimates, unassigned in-progress, oversized | 3 |
| Fixture-driven golden metric tests (hand-computed) | 2, 3, 11 (demo numbers) |
| Dashboard works without an LLM | 11, 13 |
| Widgets are zod-validated declarative specs `{metric, params, chart, title}` from a fixed catalog; per user/board persistence | 11 |
| Default Scrum and Kanban dashboards (shadcn `dashboard-01` + `chart`) | 11, 13 |
| Mock Jira (agile, search with changelog, pagination, 429) + seeded demo dataset | 5 |
| e2e: connect mock Jira → select board → map statuses → sync → Scrum and Kanban dashboards with expected numbers | 12, 13 |
| Worker in self-host compose + Dockerfile target + CI; README | 10, 14 |
| "Validated against a DC trial container + Cloud sandbox" | 6 (contract suite), 14 (manual checklist) — see ruling |
| i18n EN/FR | 0.3, 12, 13 |

Deferred by the spec to later phases (not in this plan): agent chat, analytics MCP and mcp-atlassian (Phase 3); agent-added widgets, skills, digests, insight cards from skills (Phase 4 — `saveDashboardWidgets` is the entry point it will use); multiple custom dashboards per board in the UI, portfolio view, per-workspace time zone, retention/erasure of audit rows, SSO (Phase 5). DNS pinning between the URL check and the connection stays a Phase 3 item (the sync re-checks the policy before every run).
