# More Live Jira Read Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assistant can read time tracking (estimates, time spent, worklogs, per-person totals) and more delivery context (board issues, status dates, epics, cross-project dependencies, link types, versions, components, fields, watchers) from live Jira, read-only.

**Architecture:** New entries in the Jira tool catalog (`packages/jira-tools/src/catalog.ts`), implemented by both backends (mcp-atlassian for Data Center PAT / Cloud OAuth, our REST client for Cloud API tokens) with one output shape per tool. Time tracking becomes hours: exact seconds on REST, and on mcp-atlassian (which only returns Jira's display text such as `1d 3h 12m`) parsed with the instance's working-time setting read once from `GET /rest/api/2/configuration`. `jira_worklog_summary` is our own tool composed of `jira_search` + `jira_get_worklog`, 3 requests at a time. Four composite tools exist only on mcp-atlassian connections and are offered only there. The container allowlists are generated from the catalog.

**Tech Stack:** TypeScript, zod, Vercel AI SDK `tool()`, MCP TypeScript SDK client, Node fetch with `@agile/net` outbound policy, Vitest 5 (+ Testcontainers for the contract test), pnpm 10 workspaces, Biome, promptfoo evals.

**Spec:** `docs/superpowers/specs/2026-10-05-jira-read-tools-design.md`

## Global Constraints

- Read-only: every new catalog tool has `write: false`; no approval card, no change audit.
- Roles unchanged: live Jira tools only for owners, admins, managers (`canUseLiveJira`), re-checked at execution; viewers get none. `/api/mcp` (external AI clients) is unchanged: no live Jira tool.
- Time values in hours rounded to 0.1 (`Math.round(seconds / 360) / 10`), `null` when unknown; Jira's own text is kept beside them. Never guess a day length: without the instance's setting, hours from `d`/`w` units are `null`.
- Worklog comments: plain text cut to 500 characters. People: display names only (no email, account id or username in outputs).
- `jira_worklog_summary`: at most 50 issues, at most 3 worklog requests in flight; `partial: true` when the JQL matched more, an issue's worklog failed, or the call's deadline was reached (then return what was gathered).
- Four tools are mcp-atlassian only: `jira_get_issue_dates`, `jira_get_project_epic_hierarchy`, `jira_get_cross_project_dependencies`, `jira_search_fields`. On a REST site they fail with `JiraToolError('not_supported')`; the agent offers them only when an mcp-atlassian site is usable and restricts their `site` choice to such sites.
- `jira_worklog_summary` is ours: never in `MCP_ATLASSIAN_ENABLED_TOOLS` or the read-only list. Every other new tool is in both lists (the read-only twin keeps `READ_ONLY_MODE=true`).
- Jira text reaches the model only inside the existing untrusted-data envelope (the agent already wraps every Jira tool result).
- Commit messages: one conventional subject line (`feat(jira-tools): …`, `test(jira): …`, `feat(agent): …`, `feat(web): …`, `test(evals): …`, `chore(deploy): …`), no body, no trailers, no mention of AI.
- Run commands from the repo root in Git Bash; pnpm is `npx -y pnpm@10.14.0` (written `pnpm` below). Docker is running (Testcontainers).
- Biome on Windows (`core.autocrlf=true`) reports checked-out files as misformatted; check changed files on their LF content: `F=<path>; tr -d '\r' < "$F" | pnpm exec biome check --write --stdin-file-path="$F" > /tmp/b && [ -s /tmp/b ] && cp /tmp/b "$F"`.
- Never stage `AGENTS.md`, `docker/postgres/init/01-app-role.sh` or `.superpowers/`; stage by explicit path.

## Review Focus

- A Jira time string with an unknown unit or format (localised `1j 3h`, `2.5d`, empty, `0m`) must give `null` hours or the right number, never a wrong number. → Task 1 tests.
- An issue with no time tracking at all (field absent or `null`) must give all-`null` values, not a crash or zeros. → Task 1 and Task 4 tests.
- A worklog with more than one page on REST must be read completely (or flagged `partial`), not silently truncated. → Task 4 test "pages through worklogs".
- A worklog summary over issues where one issue's worklog is forbidden must still return the others, flagged `partial`. → Task 3 test "keeps going when one issue fails".
- The working-time setting request failing (403, network) must not fail the tool: hours become `null`, text stays. → Task 5 test "keeps the text when the setting cannot be read".

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/jira-tools/src/time-tracking.ts` (new) | Hours from seconds, Jira duration parsing, the working-time setting, `TimeTracking` from REST and mcp shapes |
| `packages/jira-tools/src/worklog-summary.ts` (new) | `summarizeWorklogs()`: bounded, concurrent aggregation over injected `search`/`worklog` functions; worklog types |
| `packages/jira-tools/src/catalog.ts` (modify) | 11 new tool definitions, `mcpOnly`/`local` flags, mcp field lists |
| `packages/jira-tools/src/backend.ts` (modify) | `not_supported` error code |
| `packages/jira-tools/src/rest-backend.ts` (modify) | REST handlers for the new tools; time tracking on issue reads |
| `packages/jira-tools/src/mcp-backend.ts` (modify) | Output mapping for new tools; time tracking + setting cache; local summary; allowlists exclude `local` tools |
| `packages/jira-tools/src/index.ts` (modify) | Exports; `outbound` passed to the mcp backend |
| `packages/jira/src/testing/demo-dataset.ts`, `mock-jira-server.ts` (modify) | Time tracking, worklogs, versions, components, link types, watchers, configuration, board issues in the mock Jira |
| `packages/jira-tools/src/testing/mock-mcp-atlassian.ts` (modify) | The double serves the new REST-supported tools in mcp-atlassian's shapes |
| `packages/jira-tools/src/mcp-atlassian.contract.test.ts` (modify) | Samples for the new tools; local tool skipped where it has no mcp tool |
| `docker-compose.yml`, `docker-compose.selfhost.yml`, `deploy/helm/agile-copilot/templates/mcp-atlassian.yaml` (modify) | `ENABLED_TOOLS` follow the generated lists |
| `packages/agent/src/tools.ts`, `tool-errors.ts`, `prompt.ts` (modify) | mcp-only offering; `not_supported`; prompt sentence |
| `apps/web/src/components/agent/tool-labels.ts`, `apps/web/messages/en.json`, `fr.json` (modify) | Labels, error sentence |
| `evals/script.ts`, `evals/tests/agent.yaml` (modify) | Worklog summary eval case |

---

### Task 1: Time tracking conversion

**Files:**
- Create: `packages/jira-tools/src/time-tracking.ts`
- Test: `packages/jira-tools/src/time-tracking.test.ts`

**Interfaces:**
- Produces (exported from `time-tracking.ts`):
  - `interface TimeTrackingConfig { hoursPerDay: number; daysPerWeek: number }`
  - `interface TimeTracking { originalEstimate: string | null; remainingEstimate: string | null; timeSpent: string | null; originalEstimateHours: number | null; remainingEstimateHours: number | null; timeSpentHours: number | null }`
  - `hoursFromSeconds(seconds: unknown): number | null`
  - `parseJiraDuration(text: unknown, config: TimeTrackingConfig | null): number | null` (hours, unrounded)
  - `timeTrackingConfigFrom(raw: unknown): TimeTrackingConfig | null` (the body of `GET /rest/api/2/configuration`)
  - `timeTrackingFromRest(raw: unknown): TimeTracking` (Jira's `fields.timetracking`)
  - `timeTrackingFromMcp(raw: unknown, config: TimeTrackingConfig | null): TimeTracking` (mcp-atlassian's `timetracking`)
  - `EMPTY_TIME_TRACKING: TimeTracking` (all `null`)

- [ ] **Step 1: Write the failing tests**

Create `packages/jira-tools/src/time-tracking.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  EMPTY_TIME_TRACKING,
  hoursFromSeconds,
  parseJiraDuration,
  timeTrackingConfigFrom,
  timeTrackingFromMcp,
  timeTrackingFromRest,
} from './time-tracking';

const EIGHT = { hoursPerDay: 8, daysPerWeek: 5 };

describe('hoursFromSeconds', () => {
  it('converts to hours rounded to 0.1', () => {
    expect(hoursFromSeconds(40_320)).toBe(11.2);
    expect(hoursFromSeconds(0)).toBe(0);
    expect(hoursFromSeconds(1_800)).toBe(0.5);
  });
  it('is null for anything that is not a non-negative number', () => {
    for (const v of [null, undefined, '3600', -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(hoursFromSeconds(v)).toBeNull();
    }
  });
});

describe('parseJiraDuration', () => {
  it('reads weeks, days, hours and minutes with the instance setting', () => {
    expect(parseJiraDuration('1d 3h 12m', EIGHT)).toBeCloseTo(11.2);
    expect(parseJiraDuration('4d', EIGHT)).toBe(32);
    expect(parseJiraDuration('1w 2d', EIGHT)).toBe(56);
    expect(parseJiraDuration('1d', { hoursPerDay: 7.2, daysPerWeek: 5 })).toBeCloseTo(7.2);
  });
  it('reads hours and minutes without a setting, and decimals', () => {
    expect(parseJiraDuration('3h 30m', null)).toBe(3.5);
    expect(parseJiraDuration('0m', null)).toBe(0);
    expect(parseJiraDuration('1.5h', null)).toBe(1.5);
  });
  it('never guesses: days or weeks without a setting, or unknown text, give null', () => {
    expect(parseJiraDuration('1d', null)).toBeNull();
    expect(parseJiraDuration('1j 3h', EIGHT)).toBeNull();
    expect(parseJiraDuration('soon', EIGHT)).toBeNull();
    expect(parseJiraDuration('', EIGHT)).toBeNull();
    expect(parseJiraDuration(undefined, EIGHT)).toBeNull();
    expect(parseJiraDuration('3h 3h', EIGHT)).toBeNull();
  });
});

describe('timeTrackingConfigFrom', () => {
  it('reads the working-time setting', () => {
    expect(
      timeTrackingConfigFrom({
        timeTrackingEnabled: true,
        timeTrackingConfiguration: { workingHoursPerDay: 8, workingDaysPerWeek: 5 },
      }),
    ).toEqual(EIGHT);
  });
  it('is null when time tracking is off or the values are unusable', () => {
    expect(timeTrackingConfigFrom({ timeTrackingEnabled: false })).toBeNull();
    expect(
      timeTrackingConfigFrom({
        timeTrackingEnabled: true,
        timeTrackingConfiguration: { workingHoursPerDay: 0, workingDaysPerWeek: 5 },
      }),
    ).toBeNull();
    expect(timeTrackingConfigFrom('nope')).toBeNull();
  });
});

describe('timeTrackingFromRest', () => {
  it('uses the exact seconds and keeps the text', () => {
    expect(
      timeTrackingFromRest({
        originalEstimate: '1d 3h 12m',
        remainingEstimate: '0m',
        timeSpent: '1d 6h',
        originalEstimateSeconds: 40_320,
        remainingEstimateSeconds: 0,
        timeSpentSeconds: 50_400,
      }),
    ).toEqual({
      originalEstimate: '1d 3h 12m',
      remainingEstimate: '0m',
      timeSpent: '1d 6h',
      originalEstimateHours: 11.2,
      remainingEstimateHours: 0,
      timeSpentHours: 14,
    });
  });
  it('is all null without time tracking', () => {
    expect(timeTrackingFromRest(undefined)).toEqual(EMPTY_TIME_TRACKING);
    expect(timeTrackingFromRest({})).toEqual(EMPTY_TIME_TRACKING);
  });
});

describe('timeTrackingFromMcp', () => {
  const raw = { original_estimate: '1d 3h 12m', remaining_estimate: '0m', time_spent: '1d 6h' };
  it('parses the text with the setting', () => {
    expect(timeTrackingFromMcp(raw, EIGHT)).toEqual({
      originalEstimate: '1d 3h 12m',
      remainingEstimate: '0m',
      timeSpent: '1d 6h',
      originalEstimateHours: 11.2,
      remainingEstimateHours: 0,
      timeSpentHours: 14,
    });
  });
  it('keeps the text and gives null hours for day units without the setting', () => {
    expect(timeTrackingFromMcp(raw, null)).toEqual({
      originalEstimate: '1d 3h 12m',
      remainingEstimate: '0m',
      timeSpent: '1d 6h',
      originalEstimateHours: null,
      remainingEstimateHours: 0,
      timeSpentHours: null,
    });
  });
  it('is all null without time tracking', () => {
    expect(timeTrackingFromMcp(undefined, EIGHT)).toEqual(EMPTY_TIME_TRACKING);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/jira-tools/src/time-tracking.test.ts`
Expected: FAIL — `Cannot find module './time-tracking'`.

- [ ] **Step 3: Implement**

Create `packages/jira-tools/src/time-tracking.ts`:

```ts
/**
 * Time tracking in hours. REST gives exact seconds; mcp-atlassian only returns Jira's display text
 * ("1d 3h 12m"), which is parsed with the instance's own working-time setting: a day or a week is
 * never assumed.
 */

export interface TimeTrackingConfig {
  hoursPerDay: number;
  daysPerWeek: number;
}

export interface TimeTracking {
  originalEstimate: string | null;
  remainingEstimate: string | null;
  timeSpent: string | null;
  originalEstimateHours: number | null;
  remainingEstimateHours: number | null;
  timeSpentHours: number | null;
}

export const EMPTY_TIME_TRACKING: TimeTracking = Object.freeze({
  originalEstimate: null,
  remainingEstimate: null,
  timeSpent: null,
  originalEstimateHours: null,
  remainingEstimateHours: null,
  timeSpentHours: null,
});

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const round = (hours: number) => Math.round(hours * 10) / 10;

export function hoursFromSeconds(seconds: unknown): number | null {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? Math.round(seconds / 360) / 10
    : null;
}

const PART = /^(\d+(?:\.\d+)?)([wdhm])$/;

/** Hours in a Jira duration ("1w 2d 3h 30m"); null for anything it cannot read exactly. */
export function parseJiraDuration(value: unknown, config: TimeTrackingConfig | null): number | null {
  const t = text(value);
  if (!t) return null;
  const seen = new Set<string>();
  let hours = 0;
  for (const part of t.split(/\s+/)) {
    const m = PART.exec(part);
    if (!m) return null;
    const [, amount, unit] = m as unknown as [string, string, 'w' | 'd' | 'h' | 'm'];
    if (seen.has(unit)) return null;
    seen.add(unit);
    const n = Number(amount);
    if (unit === 'm') hours += n / 60;
    else if (unit === 'h') hours += n;
    else if (!config) return null;
    else if (unit === 'd') hours += n * config.hoursPerDay;
    else hours += n * config.hoursPerDay * config.daysPerWeek;
  }
  return hours;
}

/** The working-time setting from `GET /rest/api/2/configuration`; null when unusable. */
export function timeTrackingConfigFrom(raw: unknown): TimeTrackingConfig | null {
  const r = obj(raw);
  if (r.timeTrackingEnabled !== true) return null;
  const c = obj(r.timeTrackingConfiguration);
  const hoursPerDay = c.workingHoursPerDay;
  const daysPerWeek = c.workingDaysPerWeek;
  return typeof hoursPerDay === 'number' &&
    hoursPerDay > 0 &&
    hoursPerDay <= 24 &&
    typeof daysPerWeek === 'number' &&
    daysPerWeek > 0 &&
    daysPerWeek <= 7
    ? { hoursPerDay, daysPerWeek }
    : null;
}

/** Jira REST `fields.timetracking` (exact seconds). */
export function timeTrackingFromRest(raw: unknown): TimeTracking {
  const r = obj(raw);
  return {
    originalEstimate: text(r.originalEstimate),
    remainingEstimate: text(r.remainingEstimate),
    timeSpent: text(r.timeSpent),
    originalEstimateHours: hoursFromSeconds(r.originalEstimateSeconds),
    remainingEstimateHours: hoursFromSeconds(r.remainingEstimateSeconds),
    timeSpentHours: hoursFromSeconds(r.timeSpentSeconds),
  };
}

/** mcp-atlassian's `timetracking` (display text only), parsed with the instance's setting. */
export function timeTrackingFromMcp(
  raw: unknown,
  config: TimeTrackingConfig | null,
): TimeTracking {
  const r = obj(raw);
  const hours = (v: unknown) => {
    const h = parseJiraDuration(v, config);
    return h === null ? null : round(h);
  };
  return {
    originalEstimate: text(r.original_estimate),
    remainingEstimate: text(r.remaining_estimate),
    timeSpent: text(r.time_spent),
    originalEstimateHours: hours(r.original_estimate),
    remainingEstimateHours: hours(r.remaining_estimate),
    timeSpentHours: hours(r.time_spent),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/jira-tools/src/time-tracking.test.ts && pnpm --filter @agile/jira-tools typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Format and commit**

```bash
git add packages/jira-tools/src/time-tracking.ts packages/jira-tools/src/time-tracking.test.ts
git commit -m "feat(jira-tools): time tracking in hours from Jira seconds or Jira's text"
```

---

### Task 2: Catalog entries, error code and allowlists

**Files:**
- Modify: `packages/jira-tools/src/catalog.ts`
- Modify: `packages/jira-tools/src/backend.ts` (the `JiraToolErrorCode` union)
- Modify: `packages/jira-tools/src/mcp-backend.ts:22-37` (allowlists)
- Modify: `packages/agent/src/tool-errors.ts` (`JIRA` list), `packages/agent/src/tool-errors.test.ts`
- Modify: `apps/web/messages/en.json`, `fr.json` (`agent.toolErrors.not_supported`)
- Test: `packages/jira-tools/src/catalog.test.ts` (append), `packages/jira-tools/src/mcp-backend.test.ts` (allowlist assertions)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - catalog tools `jira_get_worklog`, `jira_worklog_summary`, `jira_get_board_issues`, `jira_get_issue_dates`, `jira_get_project_epic_hierarchy`, `jira_get_cross_project_dependencies`, `jira_get_link_types`, `jira_get_project_versions`, `jira_get_project_components`, `jira_search_fields`, `jira_get_issue_watchers` (all `write: false`);
  - optional `ToolDef` flags `mcpOnly?: true` (only mcp-atlassian connections) and `local?: true` (implemented by our backends, not an mcp-atlassian tool);
  - `JIRA_MCP_ONLY_TOOLS: ReadonlySet<JiraToolName>`, `JIRA_LOCAL_TOOLS: ReadonlySet<JiraToolName>`, `isJiraMcpOnlyTool(name: string): boolean`;
  - `MCP_ISSUE_FIELDS` (string) used by `toMcp` of `jira_search`, `jira_get_issue`, `jira_get_sprint_issues`, `jira_get_board_issues`;
  - `JiraToolErrorCode` gains `'not_supported'`; the agent's `ToolErrorCode` gains it (via the `JIRA` list).

- [ ] **Step 1: Write the failing tests**

Append to `packages/jira-tools/src/catalog.test.ts` (adapt the import line at the top to add `isJiraMcpOnlyTool`, `JIRA_LOCAL_TOOLS`, `JIRA_MCP_ONLY_TOOLS`, `MCP_ISSUE_FIELDS`):

```ts
describe('read tools for time tracking and delivery context', () => {
  const NEW_TOOLS = [
    'jira_get_worklog',
    'jira_worklog_summary',
    'jira_get_board_issues',
    'jira_get_issue_dates',
    'jira_get_project_epic_hierarchy',
    'jira_get_cross_project_dependencies',
    'jira_get_link_types',
    'jira_get_project_versions',
    'jira_get_project_components',
    'jira_search_fields',
    'jira_get_issue_watchers',
  ] as const;

  it('are all read-only', () => {
    for (const name of NEW_TOOLS) expect({ name, write: JIRA_TOOLS[name].write }).toEqual({ name, write: false });
  });

  it('marks the composite tools mcp-only and the summary local', () => {
    expect([...JIRA_MCP_ONLY_TOOLS].sort()).toEqual([
      'jira_get_cross_project_dependencies',
      'jira_get_issue_dates',
      'jira_get_project_epic_hierarchy',
      'jira_search_fields',
    ]);
    expect([...JIRA_LOCAL_TOOLS]).toEqual(['jira_worklog_summary']);
    expect(isJiraMcpOnlyTool('jira_search_fields')).toBe(true);
    expect(isJiraMcpOnlyTool('jira_get_worklog')).toBe(false);
  });

  it('asks mcp-atlassian for time tracking on issue reads', () => {
    expect(MCP_ISSUE_FIELDS.split(',')).toContain('timetracking');
    const issue = parseJiraToolInput('jira_get_issue', { issueKey: 'DEMO-1' });
    const search = parseJiraToolInput('jira_search', { jql: 'project = DEMO' });
    const sprint = parseJiraToolInput('jira_get_sprint_issues', { sprintId: '4' });
    if (!issue.success || !search.success || !sprint.success) throw new Error('invalid sample');
    expect(JIRA_TOOLS.jira_get_issue.toMcp(issue.data)).toMatchObject({ fields: MCP_ISSUE_FIELDS });
    expect(JIRA_TOOLS.jira_search.toMcp(search.data)).toMatchObject({ fields: MCP_ISSUE_FIELDS });
    expect(JIRA_TOOLS.jira_get_sprint_issues.toMcp(sprint.data)).toMatchObject({
      fields: MCP_ISSUE_FIELDS,
    });
  });

  it('bounds the inputs', () => {
    const bad = {
      jira_get_worklog: { issueKey: 'not a key' },
      jira_worklog_summary: { jql: 'project = DEMO', from: '2026-10-09', to: '2026-10-01' },
      jira_get_board_issues: { boardId: '1', limit: 51 },
      jira_get_project_epic_hierarchy: { projectKey: 'DEMO', maxEpics: 21 },
      jira_get_cross_project_dependencies: { projectKey: 'DEMO', maxIssues: 51 },
      jira_get_project_versions: { projectKey: 'demo' },
      jira_search_fields: { keyword: 'points', limit: 21 },
    } as const;
    for (const [name, input] of Object.entries(bad)) {
      expect({ name, ok: parseJiraToolInput(name as never, input).success }).toEqual({ name, ok: false });
    }
    expect(parseJiraToolInput('jira_worklog_summary', { jql: 'sprint in openSprints()', from: '2026-10-01', to: '2026-10-09' }).success).toBe(true);
    expect(parseJiraToolInput('jira_worklog_summary', { jql: 'x', from: '2026-13-01' }).success).toBe(false);
    expect(parseJiraToolInput('jira_get_link_types', {}).success).toBe(true);
  });

  it('round-trips every new mcp tool through toMcp and fromMcp', () => {
    const samples = {
      jira_get_worklog: { issueKey: 'DEMO-1' },
      jira_get_board_issues: { boardId: '1', jql: 'status = Done', limit: 20 },
      jira_get_issue_dates: { issueKey: 'DEMO-1' },
      jira_get_project_epic_hierarchy: { projectKey: 'DEMO', maxEpics: 10 },
      jira_get_cross_project_dependencies: { projectKey: 'DEMO', maxIssues: 20 },
      jira_get_link_types: {},
      jira_get_project_versions: { projectKey: 'DEMO' },
      jira_get_project_components: { projectKey: 'DEMO' },
      jira_search_fields: { keyword: 'story points', limit: 10 },
      jira_get_issue_watchers: { issueKey: 'DEMO-1' },
    } as const;
    for (const [name, input] of Object.entries(samples)) {
      const def = JIRA_TOOLS[name as keyof typeof samples];
      const parsed = def.input.parse(input);
      expect({ name, back: def.input.parse(def.fromMcp((def.toMcp as (i: unknown) => Record<string, unknown>)(parsed))) }).toEqual({ name, back: parsed });
    }
  });
});
```

In `packages/jira-tools/src/mcp-backend.test.ts`, find the existing test(s) that assert `MCP_ATLASSIAN_ENABLED_TOOLS` / `MCP_ATLASSIAN_READONLY_ENABLED_TOOLS` (search the file for those names) and add:

```ts
  it('allowlists the new native tools but never our local summary', () => {
    expect(MCP_ATLASSIAN_ENABLED_TOOLS).toContain('jira_get_worklog');
    expect(MCP_ATLASSIAN_READONLY_ENABLED_TOOLS).toContain('jira_get_worklog');
    expect(MCP_ATLASSIAN_READONLY_ENABLED_TOOLS).toContain('jira_search_fields');
    expect(MCP_ATLASSIAN_ENABLED_TOOLS).not.toContain('jira_worklog_summary');
    expect(MCP_ATLASSIAN_READONLY_ENABLED_TOOLS).not.toContain('jira_worklog_summary');
  });
```

In `packages/agent/src/tool-errors.test.ts`, add to an existing test or a new one:

```ts
  it('names a tool the connection cannot run', () => {
    expect(TOOL_ERROR_CODES).toContain('not_supported');
    expect(toolErrorText('not_supported')).toBe('The Jira request failed (not_supported).');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/jira-tools/src/catalog.test.ts packages/jira-tools/src/mcp-backend.test.ts packages/agent/src/tool-errors.test.ts`
Expected: FAIL — the new tool names are not in `JIRA_TOOLS`; `JIRA_MCP_ONLY_TOOLS`/`MCP_ISSUE_FIELDS` are not exported; `not_supported` unknown.

- [ ] **Step 3: Implement the catalog**

In `packages/jira-tools/src/catalog.ts`:

1. Extend `ToolDef`:

```ts
interface ToolDef<S extends z.ZodObject> {
  /** Writes always need the user's approval. */
  write: boolean;
  /** Only mcp-atlassian connections can run it (Data Center PAT, Cloud OAuth). */
  mcpOnly?: true;
  /** Ours, built from other tools: not an mcp-atlassian tool, never in ENABLED_TOOLS. */
  local?: true;
  description: string;
  input: S;
  toMcp(input: z.output<S>): Record<string, unknown>;
  fromMcp(args: Record<string, unknown>): z.input<S>;
}
```

2. Add helpers next to the existing ones:

```ts
const projectKey = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{0,19}$/)
  .describe('Project key');
const isoDate = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'A date such as 2026-10-01')
  .describe('Date, YYYY-MM-DD');

/**
 * Fields asked of mcp-atlassian on issue reads: its 0.23.1 defaults plus `timetracking` (its
 * default set leaves time tracking out). Passing `fields` replaces the defaults.
 */
export const MCP_ISSUE_FIELDS =
  'summary,issuetype,updated,status,labels,assignee,reporter,created,description,versions,priority,timetracking';
```

3. Change `toMcp` of three existing tools (keep `fromMcp` as is — it ignores `fields`):
   - `jira_search`: `toMcp: (i) => ({ jql: i.jql, limit: i.limit, fields: MCP_ISSUE_FIELDS }),`
   - `jira_get_issue`: `toMcp: (i) => ({ issue_key: i.issueKey, comment_limit: i.commentLimit, fields: MCP_ISSUE_FIELDS }),`
   - `jira_get_sprint_issues`: `toMcp: (i) => ({ sprint_id: i.sprintId, limit: i.limit, fields: MCP_ISSUE_FIELDS }),`
   and update their descriptions:
   - `jira_search`: `'Search Jira issues with JQL (live data, may be newer than the synced dashboards). Returns key, summary, status, assignee and time tracking (estimates and time spent, in hours and as Jira shows them).'`
   - `jira_get_issue`: `'Read one Jira issue: fields, status, assignee, description, latest comments and time tracking (original and remaining estimate, time spent, in hours and as Jira shows them).'`
   - `jira_get_sprint_issues`: `'List the issues of a sprint, with their time tracking.'`

4. Add, after `jira_get_sprint_issues` (before the write tools):

```ts
  jira_get_worklog: def({
    write: false,
    description:
      'List the worklog entries of one issue: who logged time, when, how many hours, and the comment. For totals across many issues use jira_worklog_summary.',
    input: z.object({ issueKey }),
    toMcp: (i) => ({ issue_key: i.issueKey }),
    fromMcp: (a) => ({ issueKey: str(a.issue_key) ?? '' }),
  }),
  jira_worklog_summary: def({
    write: false,
    local: true,
    description:
      'Total the time logged on the issues a JQL query matches (at most 50), per person and per issue, optionally between two dates (inclusive, by the day the work was logged for). Use it for questions such as "time logged per person this sprint".',
    input: z
      .object({ jql: text(2000).describe('JQL query'), from: isoDate.optional(), to: isoDate.optional() })
      .refine((i) => !i.from || !i.to || i.from <= i.to, 'from must not be after to'),
    toMcp: (i) => ({ jql: i.jql, ...(i.from ? { from: i.from } : {}), ...(i.to ? { to: i.to } : {}) }),
    fromMcp: (a) => ({ jql: str(a.jql) ?? '', from: str(a.from), to: str(a.to) }),
  }),
  jira_get_board_issues: def({
    write: false,
    description:
      'List the issues of a board (its filter, backlog included), optionally narrowed by JQL, with their time tracking.',
    input: z.object({
      boardId: numericId('board'),
      jql: text(2000).optional().describe('Optional JQL to narrow the board'),
      limit: limit(50, 50),
    }),
    toMcp: (i) => ({
      board_id: i.boardId,
      jql: i.jql ?? 'ORDER BY Rank ASC',
      fields: MCP_ISSUE_FIELDS,
      limit: i.limit,
    }),
    fromMcp: (a) => {
      const jql = str(a.jql);
      return {
        boardId: str(a.board_id) ?? '',
        jql: jql && jql !== 'ORDER BY Rank ASC' ? jql : undefined,
        limit: num(a.limit),
      };
    },
  }),
  jira_get_issue_dates: def({
    write: false,
    mcpOnly: true,
    description:
      'Dates of one issue (created, updated, due, resolved) and its status history with the time spent in each status.',
    input: z.object({ issueKey }),
    toMcp: (i) => ({ issue_key: i.issueKey, include_status_changes: true, include_status_summary: true }),
    fromMcp: (a) => ({ issueKey: str(a.issue_key) ?? '' }),
  }),
  jira_get_project_epic_hierarchy: def({
    write: false,
    mcpOnly: true,
    description: "Group a project's epics under their parent issues (initiatives), across projects.",
    input: z.object({
      projectKey,
      maxEpics: z.number().int().min(1).max(20).default(20).describe('At most 20 epics'),
    }),
    toMcp: (i) => ({ project_key: i.projectKey, max_epics: i.maxEpics }),
    fromMcp: (a) => ({ projectKey: str(a.project_key) ?? '', maxEpics: num(a.max_epics) }),
  }),
  jira_get_cross_project_dependencies: def({
    write: false,
    mcpOnly: true,
    description: 'List the issue links between a project and other projects (blockers and dependencies).',
    input: z.object({
      projectKey,
      maxIssues: z.number().int().min(1).max(50).default(50).describe('At most 50 issues'),
    }),
    toMcp: (i) => ({ project_key: i.projectKey, max_issues: i.maxIssues }),
    fromMcp: (a) => ({ projectKey: str(a.project_key) ?? '', maxIssues: num(a.max_issues) }),
  }),
  jira_get_link_types: def({
    write: false,
    description: 'List the issue link types (e.g. blocks / is blocked by).',
    input: z.object({}),
    toMcp: () => ({}),
    fromMcp: () => ({}),
  }),
  jira_get_project_versions: def({
    write: false,
    description: 'List the versions (releases) of a project, with their release dates and status.',
    input: z.object({ projectKey }),
    toMcp: (i) => ({ project_key: i.projectKey }),
    fromMcp: (a) => ({ projectKey: str(a.project_key) ?? '' }),
  }),
  jira_get_project_components: def({
    write: false,
    description: 'List the components of a project.',
    input: z.object({ projectKey }),
    toMcp: (i) => ({ project_key: i.projectKey }),
    fromMcp: (a) => ({ projectKey: str(a.project_key) ?? '' }),
  }),
  jira_search_fields: def({
    write: false,
    mcpOnly: true,
    description: 'Find Jira fields by name (e.g. the custom field id of "Story Points").',
    input: z.object({
      keyword: text(100).describe('Part of the field name'),
      limit: z.number().int().min(1).max(20).default(10).describe('At most 20 results'),
    }),
    toMcp: (i) => ({ keyword: i.keyword, limit: i.limit }),
    fromMcp: (a) => ({ keyword: str(a.keyword) ?? '', limit: num(a.limit) }),
  }),
  jira_get_issue_watchers: def({
    write: false,
    description: 'List who watches an issue (display names).',
    input: z.object({ issueKey }),
    toMcp: (i) => ({ issue_key: i.issueKey }),
    fromMcp: (a) => ({ issueKey: str(a.issue_key) ?? '' }),
  }),
```

5. After `JIRA_WRITE_TOOLS`, add:

```ts
/** Tools only mcp-atlassian connections can run (Data Center PAT, Cloud OAuth). */
export const JIRA_MCP_ONLY_TOOLS: ReadonlySet<JiraToolName> = new Set(
  JIRA_TOOL_NAMES.filter((n) => (JIRA_TOOLS[n] as { mcpOnly?: true }).mcpOnly),
);
/** Our own tools, built from other Jira calls: never sent to mcp-atlassian as such. */
export const JIRA_LOCAL_TOOLS: ReadonlySet<JiraToolName> = new Set(
  JIRA_TOOL_NAMES.filter((n) => (JIRA_TOOLS[n] as { local?: true }).local),
);
export const isJiraMcpOnlyTool = (name: string): boolean =>
  isJiraToolName(name) && JIRA_MCP_ONLY_TOOLS.has(name);
```

Export `isJiraMcpOnlyTool`, `JIRA_LOCAL_TOOLS`, `JIRA_MCP_ONLY_TOOLS`, `MCP_ISSUE_FIELDS` from `packages/jira-tools/src/index.ts` (add to the `./catalog` export list).

- [ ] **Step 4: Allowlists, error code**

In `packages/jira-tools/src/mcp-backend.ts`, import `JIRA_LOCAL_TOOLS` from `./catalog` and change the two lists:

```ts
/** The deployment's `ENABLED_TOOLS` for the read-write mcp-atlassian instance (our local tools excluded). */
export const MCP_ATLASSIAN_ENABLED_TOOLS: readonly string[] = Object.freeze([
  ...JIRA_TOOL_NAMES.filter((n) => !JIRA_LOCAL_TOOLS.has(n)),
  ...MCP_ATLASSIAN_BACKEND_ONLY_TOOLS,
]);
```

```ts
export const MCP_ATLASSIAN_READONLY_ENABLED_TOOLS: readonly string[] = Object.freeze(
  JIRA_TOOL_NAMES.filter((n) => !JIRA_TOOLS[n].write && !JIRA_LOCAL_TOOLS.has(n)),
);
```

In `packages/jira-tools/src/backend.ts`, add to `JiraToolErrorCode`:

```ts
  /** The tool needs an mcp-atlassian connection (Data Center PAT or Cloud OAuth). */
  | 'not_supported'
```

In `packages/agent/src/tool-errors.ts`, add `'not_supported'` to the `JIRA` list (the typecheck guard `everyJiraCodeListed` fails until you do).

In `apps/web/messages/en.json` under `agent.toolErrors` add `"not_supported": "This tool needs a Jira Data Center or Connect-with-Atlassian connection."`; in `fr.json` the same key: `"not_supported": "Cet outil nécessite une connexion Jira Data Center ou « Connect with Atlassian »."`.

- [ ] **Step 5: Keep the backends compiling**

`createRestJiraBackend`'s `handlers` object is typed `{ [N in JiraToolName]: … }`: add temporary entries for the 11 new tools so it compiles, each `async () => { throw new JiraToolError('not_supported'); }`. Tasks 4-5 replace the REST-supported ones. (This keeps every commit green.)

`packages/jira-tools/src/mcp-backend.ts` `call()`: add at the start of the `try` (after `connect`), before `writeSent = write;`:

```ts
        if (JIRA_LOCAL_TOOLS.has(name)) throw new JiraToolError('not_supported');
```

(Task 5 replaces this with the real summary.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run packages/jira-tools/src/catalog.test.ts packages/jira-tools/src/mcp-backend.test.ts packages/agent/src/tool-errors.test.ts apps/web/src/components/agent/messages.test.ts && pnpm --filter @agile/jira-tools typecheck && pnpm --filter @agile/agent typecheck && pnpm --filter @agile/web typecheck`
Expected: PASS. If other existing tests in these files assert the exact tool list or count (search for `JIRA_TOOL_NAMES` length assertions, `19 tools`-style counts, or exact `ENABLED_TOOLS` arrays), update their expected values to include the new names — the generated lists are the source of truth.

- [ ] **Step 7: Format and commit**

```bash
git add packages/jira-tools/src/catalog.ts packages/jira-tools/src/catalog.test.ts packages/jira-tools/src/backend.ts packages/jira-tools/src/mcp-backend.ts packages/jira-tools/src/mcp-backend.test.ts packages/jira-tools/src/rest-backend.ts packages/jira-tools/src/index.ts packages/agent/src/tool-errors.ts packages/agent/src/tool-errors.test.ts apps/web/messages/en.json apps/web/messages/fr.json
git commit -m "feat(jira-tools): catalog entries for time tracking and delivery-context read tools"
```

(Add any other test file you had to update in Step 6 to the `git add`.)

---

### Task 3: The worklog summary

**Files:**
- Create: `packages/jira-tools/src/worklog-summary.ts`
- Test: `packages/jira-tools/src/worklog-summary.test.ts`

**Interfaces:**
- Consumes: `JiraToolError` from `./backend`.
- Produces (exported from `worklog-summary.ts`, re-exported from `index.ts`):

```ts
export interface WorklogEntry { author: string | null; started: string | null; seconds: number; hours: number; comment: string | null }
export interface Worklog { issueKey: string; totalHours: number; entries: WorklogEntry[]; partial: boolean }
export interface WorklogSummary {
  jql: string; from: string | null; to: string | null; issuesScanned: number; partial: boolean; totalHours: number;
  byPerson: { author: string; hours: number; issues: number }[];
  topIssues: { key: string; summary: string | null; hours: number }[];
}
export const WORKLOG_SUMMARY_MAX_ISSUES = 50;
export const WORKLOG_SUMMARY_CONCURRENCY = 3;
export const WORKLOG_COMMENT_MAX = 500;
export function worklogEntry(raw: { author: unknown; started: unknown; seconds: unknown; comment: unknown }): WorklogEntry | null;
export function worklogOf(issueKey: string, entries: WorklogEntry[], partial: boolean): Worklog;
export async function summarizeWorklogs(
  input: { jql: string; from?: string; to?: string },
  deps: {
    search(jql: string, limit: number): Promise<{ hasMore: boolean; issues: { key: string | null; summary: string | null }[] }>;
    worklog(issueKey: string): Promise<Worklog>;
    signal: AbortSignal;
  },
): Promise<WorklogSummary>;
```

- [ ] **Step 1: Write the failing tests**

Create `packages/jira-tools/src/worklog-summary.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { JiraToolError } from './backend';
import {
  summarizeWorklogs,
  type Worklog,
  worklogEntry,
  worklogOf,
} from './worklog-summary';

const entry = (author: string, started: string, seconds: number) =>
  worklogEntry({ author, started, seconds, comment: null }) as NonNullable<ReturnType<typeof worklogEntry>>;

const LOGS: Record<string, Worklog> = {
  'P-1': worklogOf('P-1', [entry('Ana', '2026-10-01T09:00:00.000+0200', 7200), entry('Ben', '2026-10-02T09:00:00.000+0200', 3600)], false),
  'P-2': worklogOf('P-2', [entry('Ana', '2026-10-03T09:00:00.000+0200', 1800)], false),
  'P-3': worklogOf('P-3', [entry('Ben', '2026-09-20T09:00:00.000+0200', 36000)], false),
};
const issues = (keys: string[]) => keys.map((key) => ({ key, summary: `Summary ${key}` }));
const deps = (over: Partial<Parameters<typeof summarizeWorklogs>[1]> = {}) => ({
  search: async () => ({ hasMore: false, issues: issues(['P-1', 'P-2', 'P-3']) }),
  worklog: async (key: string) => LOGS[key] as Worklog,
  signal: new AbortController().signal,
  ...over,
});

describe('worklogEntry', () => {
  it('keeps display names, exact seconds and a short plain comment', () => {
    expect(worklogEntry({ author: 'Ana', started: '2026-10-01T09:00:00.000+0200', seconds: 5400, comment: 'x'.repeat(600) })).toEqual({
      author: 'Ana', started: '2026-10-01T09:00:00.000+0200', seconds: 5400, hours: 1.5, comment: 'x'.repeat(500),
    });
  });
  it('drops an entry without a usable duration', () => {
    expect(worklogEntry({ author: 'Ana', started: null, seconds: 'soon', comment: null })).toBeNull();
  });
});

describe('summarizeWorklogs', () => {
  it('totals per person and per issue', async () => {
    const s = await summarizeWorklogs({ jql: 'project = P' }, deps());
    expect(s).toMatchObject({ jql: 'project = P', from: null, to: null, issuesScanned: 3, partial: false, totalHours: 13.5 });
    expect(s.byPerson).toEqual([
      { author: 'Ben', hours: 11, issues: 2 },
      { author: 'Ana', hours: 2.5, issues: 2 },
    ]);
    expect(s.topIssues[0]).toEqual({ key: 'P-3', summary: 'Summary P-3', hours: 10 });
  });

  it('keeps only entries between the dates, inclusive, by the day logged', async () => {
    const s = await summarizeWorklogs({ jql: 'project = P', from: '2026-10-01', to: '2026-10-02' }, deps());
    expect(s.totalHours).toBe(3);
    expect(s.byPerson).toEqual([
      { author: 'Ana', hours: 2, issues: 1 },
      { author: 'Ben', hours: 1, issues: 1 },
    ]);
    expect(s.topIssues.map((i) => i.key)).toEqual(['P-1']);
  });

  it('scans at most 50 issues and says when there were more', async () => {
    let asked = 0;
    const s = await summarizeWorklogs({ jql: 'x' }, deps({
      search: async (_jql, limit) => {
        asked = limit;
        return { hasMore: true, issues: issues(Array.from({ length: 50 }, (_, i) => `P-${i + 1}`)) };
      },
      worklog: async (key) => worklogOf(key, [], false),
    }));
    expect(asked).toBe(50);
    expect(s).toMatchObject({ issuesScanned: 50, partial: true, totalHours: 0 });
  });

  it('never has more than 3 worklog requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    await summarizeWorklogs({ jql: 'x' }, deps({
      search: async () => ({ hasMore: false, issues: issues(Array.from({ length: 12 }, (_, i) => `P-${i + 1}`)) }),
      worklog: async (key) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return worklogOf(key, [], false);
      },
    }));
    expect(peak).toBe(3);
  });

  it('keeps going when one issue fails, flagged partial', async () => {
    const s = await summarizeWorklogs({ jql: 'x' }, deps({
      worklog: async (key) => {
        if (key === 'P-2') throw new JiraToolError('forbidden');
        return LOGS[key] as Worklog;
      },
    }));
    expect(s).toMatchObject({ issuesScanned: 3, partial: true, totalHours: 13 });
  });

  it('returns what it has when the deadline is reached', async () => {
    const ctrl = new AbortController();
    const s = await summarizeWorklogs({ jql: 'x' }, deps({
      signal: ctrl.signal,
      worklog: async (key) => {
        if (key === 'P-1') return LOGS[key] as Worklog;
        ctrl.abort();
        throw new JiraToolError('unavailable');
      },
    }));
    expect(s.partial).toBe(true);
    expect(s.totalHours).toBe(3);
  });

  it('flags partial when an issue worklog was itself partial', async () => {
    const s = await summarizeWorklogs({ jql: 'x' }, deps({
      worklog: async (key) => ({ ...(LOGS[key] as Worklog), partial: key === 'P-1' }),
    }));
    expect(s.partial).toBe(true);
  });

  it('fails like the search when the search fails', async () => {
    await expect(summarizeWorklogs({ jql: 'x' }, deps({
      search: async () => { throw new JiraToolError('invalid_request'); },
    }))).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/jira-tools/src/worklog-summary.test.ts`
Expected: FAIL — `Cannot find module './worklog-summary'`.

- [ ] **Step 3: Implement**

Create `packages/jira-tools/src/worklog-summary.ts`:

```ts
import { JiraToolError } from './backend';

export interface WorklogEntry {
  author: string | null;
  started: string | null;
  seconds: number;
  hours: number;
  comment: string | null;
}

export interface Worklog {
  issueKey: string;
  totalHours: number;
  entries: WorklogEntry[];
  /** Not every entry could be read (paging limit). */
  partial: boolean;
}

export interface WorklogSummary {
  jql: string;
  from: string | null;
  to: string | null;
  issuesScanned: number;
  partial: boolean;
  totalHours: number;
  byPerson: { author: string; hours: number; issues: number }[];
  topIssues: { key: string; summary: string | null; hours: number }[];
}

export const WORKLOG_SUMMARY_MAX_ISSUES = 50;
/** Jira Data Center rate limits are token buckets (e.g. 60 then 1 per second): stay well below. */
export const WORKLOG_SUMMARY_CONCURRENCY = 3;
export const WORKLOG_COMMENT_MAX = 500;
const TOP_ISSUES = 10;
const UNKNOWN_AUTHOR = 'Unknown';

const hours = (seconds: number) => Math.round(seconds / 360) / 10;
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** One worklog entry, or null when it has no usable duration. */
export function worklogEntry(raw: {
  author: unknown;
  started: unknown;
  seconds: unknown;
  comment: unknown;
}): WorklogEntry | null {
  const seconds = raw.seconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  const comment = text(raw.comment);
  return {
    author: text(raw.author),
    started: text(raw.started),
    seconds,
    hours: hours(seconds),
    comment: comment ? comment.slice(0, WORKLOG_COMMENT_MAX) : null,
  };
}

export function worklogOf(issueKey: string, entries: WorklogEntry[], partial: boolean): Worklog {
  return {
    issueKey,
    totalHours: hours(entries.reduce((sum, e) => sum + e.seconds, 0)),
    entries,
    partial,
  };
}

/** The calendar day a worklog was logged for, as Jira wrote it ("2026-10-01T09:00:00.000+0200"). */
const dayOf = (started: string | null) => (started && /^\d{4}-\d{2}-\d{2}/.test(started) ? started.slice(0, 10) : null);

/**
 * Time logged on the issues `jql` matches (at most 50), per person and per issue. Worklogs are
 * fetched a few at a time; an issue whose worklog fails, or the call's deadline, makes the result
 * partial instead of failing it. Only the search failing fails the call.
 */
export async function summarizeWorklogs(
  input: { jql: string; from?: string; to?: string },
  deps: {
    search(
      jql: string,
      limit: number,
    ): Promise<{ hasMore: boolean; issues: { key: string | null; summary: string | null }[] }>;
    worklog(issueKey: string): Promise<Worklog>;
    signal: AbortSignal;
  },
): Promise<WorklogSummary> {
  const found = await deps.search(input.jql, WORKLOG_SUMMARY_MAX_ISSUES);
  const issues = found.issues
    .filter((i): i is { key: string; summary: string | null } => typeof i.key === 'string')
    .slice(0, WORKLOG_SUMMARY_MAX_ISSUES);
  let partial = found.hasMore || found.issues.length > WORKLOG_SUMMARY_MAX_ISSUES;
  const from = input.from ?? null;
  const to = input.to ?? null;
  const inRange = (e: WorklogEntry) => {
    if (!from && !to) return true;
    const day = dayOf(e.started);
    return day !== null && (!from || day >= from) && (!to || day <= to);
  };

  const perIssue = new Map<string, number>();
  const perPerson = new Map<string, { seconds: number; issues: Set<string> }>();
  let next = 0;
  const worker = async () => {
    while (next < issues.length && !deps.signal.aborted) {
      const issue = issues[next++] as { key: string; summary: string | null };
      let log: Worklog;
      try {
        log = await deps.worklog(issue.key);
      } catch (e) {
        if (!(e instanceof JiraToolError)) throw e;
        partial = true;
        continue;
      }
      if (log.partial) partial = true;
      for (const e of log.entries.filter(inRange)) {
        perIssue.set(issue.key, (perIssue.get(issue.key) ?? 0) + e.seconds);
        const author = e.author ?? UNKNOWN_AUTHOR;
        const p = perPerson.get(author) ?? { seconds: 0, issues: new Set<string>() };
        p.seconds += e.seconds;
        p.issues.add(issue.key);
        perPerson.set(author, p);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(WORKLOG_SUMMARY_CONCURRENCY, issues.length) }, worker),
  );
  if (next < issues.length) partial = true;

  const summaries = new Map(issues.map((i) => [i.key, i.summary]));
  const total = [...perIssue.values()].reduce((a, b) => a + b, 0);
  return {
    jql: input.jql,
    from,
    to,
    issuesScanned: issues.length,
    partial,
    totalHours: hours(total),
    byPerson: [...perPerson.entries()]
      .sort((a, b) => b[1].seconds - a[1].seconds || a[0].localeCompare(b[0]))
      .map(([author, p]) => ({ author, hours: hours(p.seconds), issues: p.issues.size })),
    topIssues: [...perIssue.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, TOP_ISSUES)
      .map(([key, seconds]) => ({ key, summary: summaries.get(key) ?? null, hours: hours(seconds) })),
  };
}
```

Re-export from `packages/jira-tools/src/index.ts`:

```ts
export {
  summarizeWorklogs,
  type Worklog,
  type WorklogEntry,
  type WorklogSummary,
  worklogEntry,
  worklogOf,
} from './worklog-summary';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/jira-tools/src/worklog-summary.test.ts && pnpm --filter @agile/jira-tools typecheck`
Expected: PASS. ("returns what it has when the deadline is reached": `P-1` is fetched by the first worker, the abort stops the loop, `issuesScanned` stays 3 and `partial` is true.)

- [ ] **Step 5: Format and commit**

```bash
git add packages/jira-tools/src/worklog-summary.ts packages/jira-tools/src/worklog-summary.test.ts packages/jira-tools/src/index.ts
git commit -m "feat(jira-tools): bounded worklog summary per person and per issue"
```

---

### Task 4: The mock Jira and the REST backend

**Files:**
- Modify: `packages/jira/src/testing/demo-dataset.ts`, `packages/jira/src/testing/mock-jira-server.ts`
- Test: `packages/jira/src/testing/mock-jira-server.test.ts` (append)
- Modify: `packages/jira-tools/src/rest-backend.ts`
- Test: `packages/jira-tools/src/rest-backend.test.ts` (append)

**Interfaces:**
- Consumes: `timeTrackingFromRest`, `EMPTY_TIME_TRACKING`, `type TimeTracking` (Task 1); `summarizeWorklogs`, `worklogEntry`, `worklogOf`, `type Worklog` (Task 3); catalog tools (Task 2).
- Produces:
  - REST output shapes (the mcp backend must return the same in Task 5):
    - issues in `jira_search`, `jira_get_sprint_issues`, `jira_get_board_issues`: the existing `brief` fields plus `timeTracking: TimeTracking`;
    - `jira_get_issue`: today's object plus `timeTracking: TimeTracking`;
    - `jira_get_board_issues`: `{ total: number | null, hasMore: boolean, issues: [...] }` (same as `jira_search`);
    - `jira_get_worklog`: `Worklog`;
    - `jira_worklog_summary`: `WorklogSummary`;
    - `jira_get_link_types`: `{ linkTypes: { id: string | null; name: string | null; inward: string | null; outward: string | null }[] }`;
    - `jira_get_project_versions`: `{ versions: { id: string | null; name: string | null; released: boolean | null; archived: boolean | null; releaseDate: string | null; description: string | null }[] }`;
    - `jira_get_project_components`: `{ components: { id: string | null; name: string | null; description: string | null; lead: string | null }[] }`;
    - `jira_get_issue_watchers`: `{ issueKey: string; count: number; watchers: string[] }` (display names);
    - the four mcp-only tools: `JiraToolError('not_supported')`.
  - Mock Jira: dataset `MockIssue.fields.timetracking` on some issues; `MockJiraDataset` gains optional `worklogs: Record<string, MockWorklog[]>`, `versions`, `components`, `linkTypes`, `watchers`, `timeTracking: { workingHoursPerDay, workingDaysPerWeek } | null`.

- [ ] **Step 1: Extend the mock Jira dataset and routes (with tests)**

In `packages/jira/src/testing/demo-dataset.ts`:
- Add types:

```ts
export interface MockWorklog {
  id: string;
  author: { accountId: string; name: string; displayName: string };
  started: string;
  timeSpentSeconds: number;
  comment?: string;
}
```

  and to `MockJiraDataset` (all optional so existing datasets stay valid):

```ts
  worklogs?: Record<string, MockWorklog[]>;
  versions?: Record<string, { id: string; name: string; released: boolean; archived: boolean; releaseDate?: string; description?: string }[]>;
  components?: Record<string, { id: string; name: string; description?: string; lead?: { displayName: string } }[]>;
  linkTypes?: { id: string; name: string; inward: string; outward: string }[];
  watchers?: Record<string, { displayName: string; name: string; accountId: string; emailAddress?: string }[]>;
  /** null = time tracking disabled. */
  timeTracking?: { workingHoursPerDay: number; workingDaysPerWeek: number } | null;
```

- In `demoDataset(anchor)`: give DEMO-1 `fields.timetracking = { originalEstimate: '1d 3h 12m', remainingEstimate: '0m', timeSpent: '1d 6h', originalEstimateSeconds: 40320, remainingEstimateSeconds: 0, timeSpentSeconds: 50400 }` and DEMO-2 `{ originalEstimate: '4d', remainingEstimate: '3d 4h', timeSpent: '4h', originalEstimateSeconds: 115200, remainingEstimateSeconds: 100800, timeSpentSeconds: 14400 }`; return `worklogs` for DEMO-1 (two entries by the dataset's existing assignees: 7200 s and 3600 s on two different days relative to `anchor`, one with comment `'Pipeline <b>fix</b>'`) and DEMO-2 (one entry, 14400 s); `versions: { DEMO: [{ id: '10000', name: '1.0', released: true, archived: false, releaseDate: <anchor - 10 days, YYYY-MM-DD> }, { id: '10001', name: '1.1', released: false, archived: false }] }`; `components: { DEMO: [{ id: '20000', name: 'API', lead: { displayName: '<an existing assignee display name>' } }] }`; `linkTypes: [{ id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }]`; `watchers: { 'DEMO-1': [<one existing user with an emailAddress>] }`; `timeTracking: { workingHoursPerDay: 8, workingDaysPerWeek: 5 }`. Use the dataset's existing user identities (search the file for the assignee objects) so names are consistent.

In `packages/jira/src/testing/mock-jira-server.ts`, add routes (GET only, both flavors, same prefix handling as the existing routes; unknown issue → 404 like the issue route):
- `/rest/api/{2,3}/configuration` → `{ timeTrackingEnabled: ds.timeTracking != null, timeTrackingConfiguration: { workingHoursPerDay, workingDaysPerWeek, timeFormat: 'pretty', defaultUnit: 'hour' } }` (only `timeTrackingEnabled: false` when null);
- `/rest/api/{2,3}/issue/{key}/worklog?startAt&maxResults` → `{ startAt, maxResults, total, worklogs: [...] }` paged (default `maxResults` 20 so paging is exercised), each worklog `{ id, author: <flavor-shaped user like the user search: Cloud accountId+displayName, DC key/name/displayName>, started, timeSpentSeconds, timeSpent: '<h>h', comment }`;
- `/rest/api/{2,3}/issue/{key}/watchers` → `{ watchCount, isWatching: false, watchers: [<flavor-shaped user, with emailAddress when present>] }`;
- `/rest/api/{2,3}/issueLinkType` → `{ issueLinkTypes: ds.linkTypes ?? [] }`;
- `/rest/api/{2,3}/project/{key}/versions` → the project's versions array (`[]` when none; 404 when the project key is not any board's `projectKey`);
- `/rest/api/{2,3}/project/{key}/components` → the components array (same 404 rule);
- `/rest/agile/1.0/board/{id}/issue?jql&maxResults&fields` → issues of the board's filter (`filterIds` contains the board's `filterId`), `jql` ignored except a `status = "<name>"` clause if the existing search already supports such a clause (reuse the existing search's JQL matcher if there is one; otherwise ignore `jql`), shaped with the existing `issueJson`; 404 for an unknown board;
- the existing issue and search routes must include `fields.timetracking` whenever the issue has it and the `fields` parameter is absent, `*all`, or contains `timetracking`.

Append to `packages/jira/src/testing/mock-jira-server.test.ts` one test per route: start a mock with `demoDataset(anchor)` for each flavor and assert status 200 and the key fields above (worklog paging: `total` 2 for DEMO-1 and `maxResults=1` returns one entry with `startAt` honoured; watchers include `emailAddress` in the raw mock answer — the backends must drop it; configuration gives 8 and 5; board 1 issue list contains DEMO-1).

Run: `pnpm vitest run packages/jira/src/testing/mock-jira-server.test.ts packages/jira/src/testing/demo-dataset.test.ts`
Expected: PASS (demo-dataset tests unchanged; if one pins the dataset's exact top-level keys, add the new keys to it).

Commit:

```bash
git add packages/jira/src/testing/demo-dataset.ts packages/jira/src/testing/mock-jira-server.ts packages/jira/src/testing/mock-jira-server.test.ts
git commit -m "test(jira): time tracking, worklogs and project metadata in the mock Jira"
```

(Add `demo-dataset.test.ts` if you changed it.)

- [ ] **Step 2: Write the failing REST backend tests**

Append to `packages/jira-tools/src/rest-backend.test.ts`, inside the existing `describe` that starts the Cloud mock (reuse its `backend()` helper):

```ts
  it('reads time tracking on issues in hours', async () => {
    const issue = (await backend().call('jira_get_issue', { issueKey: 'DEMO-1', commentLimit: 0 })) as { timeTracking: unknown };
    expect(issue.timeTracking).toEqual({
      originalEstimate: '1d 3h 12m', remainingEstimate: '0m', timeSpent: '1d 6h',
      originalEstimateHours: 11.2, remainingEstimateHours: 0, timeSpentHours: 14,
    });
    const found = (await backend().call('jira_search', { jql: 'project = DEMO', limit: 20 })) as { issues: { key: string; timeTracking: { timeSpentHours: number | null } }[] };
    expect(found.issues.find((i) => i.key === 'DEMO-2')?.timeTracking.timeSpentHours).toBe(4);
    expect(found.issues.find((i) => i.key === 'DEMO-3')?.timeTracking.timeSpentHours).toBeNull();
  });

  it('pages through worklogs and keeps display names only', async () => {
    const log = (await backend().call('jira_get_worklog', { issueKey: 'DEMO-1' })) as import('./worklog-summary').Worklog;
    expect(log).toMatchObject({ issueKey: 'DEMO-1', totalHours: 3, partial: false });
    expect(log.entries).toHaveLength(2);
    expect(JSON.stringify(log)).not.toMatch(/accountId|emailAddress|u-/);
    expect(cloud.requests.filter((r) => r.path.includes('/worklog')).length).toBeGreaterThanOrEqual(1);
  });

  it('totals worklogs over a JQL query', async () => {
    const s = (await backend().call('jira_worklog_summary', { jql: 'project = DEMO' })) as import('./worklog-summary').WorklogSummary;
    expect(s.totalHours).toBe(7);
    expect(s.partial).toBe(false);
    expect(s.byPerson.reduce((a, p) => a + p.hours, 0)).toBe(7);
  });

  it('lists board issues, link types, versions, components and watchers', async () => {
    const board = (await backend().call('jira_get_board_issues', { boardId: '1', limit: 50 })) as { issues: { key: string }[] };
    expect(board.issues.map((i) => i.key)).toContain('DEMO-1');
    expect(await backend().call('jira_get_link_types', {})).toEqual({
      linkTypes: [{ id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }],
    });
    const versions = (await backend().call('jira_get_project_versions', { projectKey: 'DEMO' })) as { versions: { name: string; released: boolean }[] };
    expect(versions.versions.map((v) => [v.name, v.released])).toEqual([['1.0', true], ['1.1', false]]);
    const components = (await backend().call('jira_get_project_components', { projectKey: 'DEMO' })) as { components: { name: string }[] };
    expect(components.components.map((c) => c.name)).toEqual(['API']);
    const watchers = (await backend().call('jira_get_issue_watchers', { issueKey: 'DEMO-1' })) as { count: number; watchers: string[] };
    expect(watchers.count).toBe(1);
    expect(JSON.stringify(watchers)).not.toMatch(/@|accountId/);
  });

  it('refuses the mcp-only tools with not_supported', async () => {
    for (const [name, input] of [
      ['jira_get_issue_dates', { issueKey: 'DEMO-1' }],
      ['jira_get_project_epic_hierarchy', { projectKey: 'DEMO', maxEpics: 20 }],
      ['jira_get_cross_project_dependencies', { projectKey: 'DEMO', maxIssues: 50 }],
      ['jira_search_fields', { keyword: 'points', limit: 10 }],
    ] as const) {
      await expect(backend().call(name, input as never)).rejects.toMatchObject({ code: 'not_supported' });
    }
  });
```

Adjust the expected totals to the worklog seconds you put in the dataset in Step 1 (7200 + 3600 = 3 h on DEMO-1, 14400 = 4 h on DEMO-2 → 7 h). If the demo project has more than 50 issues, `partial` is legitimately true for `project = DEMO`: use a JQL the mock supports that selects at most 50 issues including DEMO-1 and DEMO-2 (e.g. a `key in (…)` clause if the mock's JQL handles it, otherwise a status or sprint clause), in this test and in the summary tests of Tasks 5 and 8; if `cloud.requests` has a different name in the mock, use the mock's request log property (see `mock-jira-server.ts`).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/jira-tools/src/rest-backend.test.ts`
Expected: FAIL — no `timeTracking` on issues; the new tools throw `not_supported` from Task 2's placeholders.

- [ ] **Step 4: Implement the REST handlers**

In `packages/jira-tools/src/rest-backend.ts`:
- `const FIELDS = 'summary,status,assignee,issuetype,updated,labels,timetracking';`
- `RawIssue.fields` gains `timetracking?: unknown;`
- `brief` adds `timeTracking: timeTrackingFromRest(i.fields?.timetracking),`
- `jira_get_issue`: add `timeTracking: timeTrackingFromRest(i.fields?.timetracking)` to its returned object (its request already uses `${FIELDS},description,comment`).
- Replace the placeholders:

```ts
    async jira_get_worklog({ issueKey }, signal) {
      return readWorklog(signal, issueKey);
    },
    async jira_worklog_summary(input, signal) {
      return summarizeWorklogs(input, {
        search: (jql, limit) =>
          handlers.jira_search({ jql, limit }, signal) as Promise<{
            hasMore: boolean;
            issues: { key: string | null; summary: string | null }[];
          }>,
        worklog: (key) => readWorklog(signal, key),
        signal,
      });
    },
    async jira_get_board_issues({ boardId, jql, limit }, signal) {
      const page = (await request(
        signal,
        'GET',
        `/rest/agile/1.0/board/${boardId}/issue${q({ jql, maxResults: limit, fields: FIELDS })}`,
      )) as { issues?: RawIssue[]; total?: unknown };
      const issues = (page?.issues ?? []).slice(0, limit).map(brief);
      const total = n(page?.total);
      return { total, hasMore: total !== null && total > issues.length, issues };
    },
    async jira_get_link_types(_input, signal) {
      const r = (await request(signal, 'GET', '/rest/api/2/issueLinkType')) as { issueLinkTypes?: unknown[] };
      return {
        linkTypes: (r?.issueLinkTypes ?? []).map((v) => {
          const t = (v ?? {}) as Record<string, unknown>;
          return { id: s(t.id), name: s(t.name), inward: s(t.inward), outward: s(t.outward) };
        }),
      };
    },
    async jira_get_project_versions({ projectKey }, signal) {
      const r = await request(signal, 'GET', `/rest/api/2/project/${encodeURIComponent(projectKey)}/versions`);
      return {
        versions: (Array.isArray(r) ? r : []).map((v) => {
          const t = (v ?? {}) as Record<string, unknown>;
          return {
            id: s(t.id),
            name: s(t.name),
            released: typeof t.released === 'boolean' ? t.released : null,
            archived: typeof t.archived === 'boolean' ? t.archived : null,
            releaseDate: s(t.releaseDate),
            description: s(t.description),
          };
        }),
      };
    },
    async jira_get_project_components({ projectKey }, signal) {
      const r = await request(signal, 'GET', `/rest/api/2/project/${encodeURIComponent(projectKey)}/components`);
      return {
        components: (Array.isArray(r) ? r : []).map((v) => {
          const t = (v ?? {}) as Record<string, unknown>;
          const lead = (t.lead ?? {}) as Record<string, unknown>;
          return { id: s(t.id), name: s(t.name), description: s(t.description), lead: s(lead.displayName) };
        }),
      };
    },
    async jira_get_issue_watchers({ issueKey }, signal) {
      const r = (await request(signal, 'GET', `${issuePath(issueKey)}/watchers`)) as {
        watchCount?: unknown;
        watchers?: unknown[];
      };
      const watchers = (r?.watchers ?? []).flatMap((v) => {
        const name = s(((v ?? {}) as Record<string, unknown>).displayName);
        return name ? [name] : [];
      });
      return { issueKey, count: n(r?.watchCount) ?? watchers.length, watchers };
    },
    async jira_get_issue_dates() {
      throw new JiraToolError('not_supported');
    },
    async jira_get_project_epic_hierarchy() {
      throw new JiraToolError('not_supported');
    },
    async jira_get_cross_project_dependencies() {
      throw new JiraToolError('not_supported');
    },
    async jira_search_fields() {
      throw new JiraToolError('not_supported');
    },
```

- Add, next to `findUser`:

```ts
  /** Worklog pages, at most 5 × 100 entries; more than that is flagged partial. */
  async function readWorklog(signal: AbortSignal, issueKey: string): Promise<Worklog> {
    const PAGE = 100;
    const MAX_PAGES = 5;
    const entries: WorklogEntry[] = [];
    let startAt = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = (await request(
        signal,
        'GET',
        `${issuePath(issueKey)}/worklog${q({ startAt, maxResults: PAGE })}`,
      )) as { worklogs?: unknown[]; total?: unknown };
      const batch = r?.worklogs ?? [];
      for (const v of batch) {
        const w = (v ?? {}) as Record<string, unknown>;
        const e = worklogEntry({
          author: ((w.author ?? {}) as Record<string, unknown>).displayName,
          started: w.started,
          seconds: w.timeSpentSeconds,
          comment: w.comment,
        });
        if (e) entries.push(e);
      }
      startAt += batch.length;
      const total = n(r?.total);
      if (batch.length === 0 || total === null || startAt >= total) return worklogOf(issueKey, entries, false);
    }
    return worklogOf(issueKey, entries, true);
  }
```

  with imports `import { timeTrackingFromRest } from './time-tracking';` and `import { summarizeWorklogs, type Worklog, type WorklogEntry, worklogEntry, worklogOf } from './worklog-summary';`. (`handlers.jira_search` inside `jira_worklog_summary` is fine: the object is fully built before any call runs.) On Cloud, `comment` in worklogs from REST v2 is a string; if a test shows an object (ADF), keep `null`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run packages/jira-tools/src/rest-backend.test.ts packages/jira-tools/src/catalog.test.ts && pnpm --filter @agile/jira-tools typecheck`
Expected: PASS. Existing REST tests that compare whole issue objects (`toEqual`) need `timeTracking` added to their expectations (all-null for issues without it); update them.

- [ ] **Step 6: Format and commit**

```bash
git add packages/jira-tools/src/rest-backend.ts packages/jira-tools/src/rest-backend.test.ts
git commit -m "feat(jira-tools): REST backend reads time tracking, worklogs and project metadata"
```

---

### Task 5: The mcp-atlassian backend

**Files:**
- Modify: `packages/jira-tools/src/mcp-backend.ts`
- Modify: `packages/jira-tools/src/index.ts` (`createJiraToolBackend` passes `outbound` to the mcp backend)
- Modify: `packages/jira-tools/src/testing/mock-mcp-atlassian.ts` (the double serves the new REST-supported tools in mcp-atlassian's shapes)
- Test: `packages/jira-tools/src/mcp-backend.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 (`timeTrackingFromMcp`, `timeTrackingConfigFrom`, `type TimeTrackingConfig`), Task 3 (`summarizeWorklogs`, `worklogEntry`, `worklogOf`), Task 4 output shapes.
- Produces:
  - `createMcpAtlassianBackend(creds, opts: { url: string; timeoutMs?: number; outbound?: OutboundPolicy; atlassianApiBase?: string })`;
  - pure mappers exported for tests: `issueFromMcp(raw: unknown, config: TimeTrackingConfig | null)` (adds `timeTracking`, drops raw `timetracking`), `searchFromMcp(raw, limit, config?)` (issues gain `timeTracking`), `worklogFromMcp(issueKey: string, raw: unknown): Worklog`, `watchersFromMcp(issueKey: string, raw: unknown)`, `linkTypesFromMcp(raw)`, `versionsFromMcp(raw)`, `componentsFromMcp(raw)`;
  - every mcp-supported tool returns the Task 4 shape; the four mcp-only tools return mcp-atlassian's own JSON (they have no REST twin).

- [ ] **Step 1: Write the failing mapper tests**

Append to `packages/jira-tools/src/mcp-backend.test.ts` (import the new mappers):

```ts
describe('mcp-atlassian result mapping', () => {
  const EIGHT = { hoursPerDay: 8, daysPerWeek: 5 };

  it('adds time tracking in hours to an issue and drops the raw text block', () => {
    const issue = issueFromMcp(
      { key: 'AIA-1', summary: 's', timetracking: { original_estimate: '4d', remaining_estimate: '3d 4h', time_spent: '4h' } },
      EIGHT,
    ) as Record<string, unknown>;
    expect(issue.timeTracking).toEqual({
      originalEstimate: '4d', remainingEstimate: '3d 4h', timeSpent: '4h',
      originalEstimateHours: 32, remainingEstimateHours: 28, timeSpentHours: 4,
    });
    expect(issue).not.toHaveProperty('timetracking');
  });

  it('adds time tracking to search results', () => {
    const r = searchFromMcp(
      { total: 1, issues: [{ key: 'AIA-1', summary: 's', timetracking: { time_spent: '1d' } }] },
      10,
      EIGHT,
    );
    expect(r.issues[0]?.timeTracking.timeSpentHours).toBe(8);
  });

  it('maps worklogs to exact hours, display names and short comments', () => {
    const log = worklogFromMcp('AIA-1', {
      worklogs: [
        { time_spent: '2h', time_spent_seconds: 7200, author: { display_name: 'Ana', email: 'ana@x', name: 'ana' }, comment: 'x'.repeat(700), started: '2026-10-01T09:00:00.000+0200' },
        { time_spent: '?', author: { display_name: 'Ben' } },
      ],
    });
    expect(log).toEqual({
      issueKey: 'AIA-1',
      totalHours: 2,
      partial: false,
      entries: [{ author: 'Ana', started: '2026-10-01T09:00:00.000+0200', seconds: 7200, hours: 2, comment: 'x'.repeat(500) }],
    });
  });

  it('keeps watcher display names only', () => {
    expect(
      watchersFromMcp('AIA-1', { issue_key: 'AIA-1', watcher_count: 2, watchers: [{ display_name: 'Ana', email: 'a@x', name: 'ana' }, { display_name: 'Ben' }] }),
    ).toEqual({ issueKey: 'AIA-1', count: 2, watchers: ['Ana', 'Ben'] });
  });
});
```

Before writing `versionsFromMcp` / `componentsFromMcp` / `linkTypesFromMcp` / `watchersFromMcp`, read mcp-atlassian 0.23.1's actual JSON for those tools (run the contract test from Task 6 locally with a temporary `console.log` of `callText`'s parsed output, or read the image's source: `docker run --rm --entrypoint python <MCP_ATLASSIAN_IMAGE from packages/jira-tools/src/image.ts> -c "import inspect,mcp_atlassian.servers.jira as m; print(inspect.getsource(m.get_project_versions))"` and the models it returns), and write one test per mapper with that real shape, asserting the Task 4 output shape. Key names in the watcher test above are an assumption: correct them to the image's real ones.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/jira-tools/src/mcp-backend.test.ts`
Expected: FAIL — the mappers are not exported.

- [ ] **Step 3: Implement the mappers and the backend changes**

In `packages/jira-tools/src/mcp-backend.ts`:

1. Mappers (exported), using `obj`/`s` already in the file and the imports `import { type TimeTrackingConfig, timeTrackingConfigFrom, timeTrackingFromMcp } from './time-tracking';` and `import { summarizeWorklogs, type Worklog, type WorklogEntry, worklogEntry, worklogOf } from './worklog-summary';`:

```ts
/** An mcp-atlassian issue with `timeTracking` in hours; the raw `timetracking` text block dropped. */
export function issueFromMcp(raw: unknown, config: TimeTrackingConfig | null) {
  const { timetracking, ...rest } = obj(raw);
  return { ...rest, timeTracking: timeTrackingFromMcp(timetracking, config) };
}

export function worklogFromMcp(issueKey: string, raw: unknown): Worklog {
  const list = obj(raw).worklogs;
  const entries = (Array.isArray(list) ? list : []).flatMap((v) => {
    const w = obj(v);
    const e = worklogEntry({
      author: obj(w.author).display_name,
      started: w.started,
      seconds: w.time_spent_seconds,
      comment: w.comment,
    });
    return e ? [e] : [];
  });
  return worklogOf(issueKey, entries, false);
}
```

   `watchersFromMcp`, `linkTypesFromMcp`, `versionsFromMcp`, `componentsFromMcp`: map the image's real keys (Step 1) to the Task 4 shapes; never pass through email, account id or username.

2. `searchFromMcp(raw, limit, config: TimeTrackingConfig | null = null)`: each issue gains `timeTracking: timeTrackingFromMcp(i.timetracking, config)`.

3. Options and the working-time setting:

```ts
export function createMcpAtlassianBackend(
  creds: McpCredentials,
  opts: { url: string; timeoutMs?: number; outbound?: OutboundPolicy; atlassianApiBase?: string },
): JiraToolBackend {
```

   Module-level cache and loader:

```ts
const SETTING_TTL_MS = 60 * 60 * 1000;
const settings = new Map<string, { config: TimeTrackingConfig | null; at: number }>();

/**
 * The instance's working-time setting (hours per day, days per week), read with the connection's
 * own credentials and cached per Jira for an hour. mcp-atlassian does not expose it, and its
 * time-tracking output is display text only. Any failure gives null: hours are then left unknown
 * rather than guessed.
 */
async function workingTime(
  creds: McpCredentials,
  opts: { outbound?: OutboundPolicy; atlassianApiBase?: string },
  signal: AbortSignal,
): Promise<TimeTrackingConfig | null> {
  if (!opts.outbound) return null;
  const base =
    creds.kind === 'datacenter_pat'
      ? creds.baseUrl.replace(/\/+$/, '')
      : `${opts.atlassianApiBase ?? 'https://api.atlassian.com'}/ex/jira/${creds.cloudId}`;
  const cached = settings.get(base);
  if (cached && Date.now() - cached.at < SETTING_TTL_MS) return cached.config;
  let config: TimeTrackingConfig | null = null;
  try {
    const res = await createOutboundFetch(opts.outbound)(new URL(`${base}/rest/api/2/configuration`), {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${creds.kind === 'datacenter_pat' ? creds.token : creds.accessToken}`,
      },
      signal,
    });
    if (res.ok) config = timeTrackingConfigFrom(JSON.parse(await readCapped(res, 64 * 1024)));
    else await res.body?.cancel();
  } catch {
    config = null;
  }
  settings.set(base, { config, at: Date.now() });
  return config;
}
```

   (`createOutboundFetch` from `@agile/net`, `type OutboundPolicy` from `@agile/net`; `readCapped` from `./no-redirect-client` if exported there, otherwise from where `rest-backend.ts` imports it. `createOutboundFetch` refuses redirects and pins DNS like the REST backend. A failed read is cached too, so a Jira without the endpoint costs one request an hour.)

4. In `call()`, replace the `JIRA_LOCAL_TOOLS` placeholder and the post-processing:

```ts
        if (name === 'jira_worklog_summary') {
          return summarizeWorklogs(input as JiraToolInput<'jira_worklog_summary'>, {
            search: async (jql, limit) =>
              searchFromMcp(
                await callText(client, signal, 'jira_search', JIRA_TOOLS.jira_search.toMcp({ jql, limit })),
                limit,
              ),
            worklog: async (key) =>
              worklogFromMcp(key, await callText(client, signal, 'jira_get_worklog', { issue_key: key })),
            signal,
          });
        }
```

   (one MCP client, sequential `callTool` messages over one session are fine; concurrency of 3 is enforced by `summarizeWorklogs`.)

   After the generic `const out = await callText(...)`:

```ts
        const config = /^(jira_search|jira_get_issue|jira_get_sprint_issues|jira_get_board_issues)$/.test(name)
          ? await workingTime(creds, opts, signal)
          : null;
        if (name === 'jira_search') return searchFromMcp(out, (input as JiraToolInput<'jira_search'>).limit, config);
        if (name === 'jira_get_board_issues') return searchFromMcp(out, (input as JiraToolInput<'jira_get_board_issues'>).limit, config);
        if (name === 'jira_get_issue') return issueFromMcp(out, config);
        if (name === 'jira_get_sprint_issues') {
          const r = obj(out);
          return Array.isArray(r.issues) ? { ...r, issues: r.issues.map((i) => issueFromMcp(i, config)) } : out;
        }
        if (name === 'jira_get_worklog') return worklogFromMcp((input as JiraToolInput<'jira_get_worklog'>).issueKey, out);
        if (name === 'jira_get_issue_watchers') return watchersFromMcp((input as JiraToolInput<'jira_get_issue_watchers'>).issueKey, out);
        if (name === 'jira_get_link_types') return linkTypesFromMcp(out);
        if (name === 'jira_get_project_versions') return versionsFromMcp(out);
        if (name === 'jira_get_project_components') return componentsFromMcp(out);
        if (name === 'jira_get_transitions') return transitionsFromMcp(out);
        return out;
```

   (Check what `jira_get_board_issues` returns in mcp-atlassian 0.23.1 — like `jira_search` it is expected to be `{ total, start_at, max_results, issues }`; if not, write a dedicated mapper with a test.)

5. In `packages/jira-tools/src/index.ts`, `createJiraToolBackend` passes the policy:

```ts
  return createMcpAtlassianBackend(creds, {
    url: opts.mcpAtlassianUrl,
    timeoutMs: opts.timeoutMs,
    outbound: opts.outbound,
  });
```

6. The double (`testing/mock-mcp-atlassian.ts`): it serves catalog tools by calling the REST backend (`fromMcp` → `createRestJiraBackend`). Make it answer in mcp-atlassian's shapes for the changed and new tools, so the mcp backend's mappers are exercised end to end:
   - `jira_search` / `jira_get_board_issues` / `jira_get_sprint_issues` / `jira_get_issue`: add `timetracking: { original_estimate, remaining_estimate, time_spent }` (from the REST `timeTracking` text values, omitting nulls) to each issue, and drop `timeTracking`;
   - `jira_get_worklog`: `{ worklogs: entries.map((e) => ({ time_spent_seconds: e.seconds, time_spent: \`${e.hours}h\`, author: { display_name: e.author }, comment: e.comment, started: e.started })) }`;
   - watchers / link types / versions / components: the image's real shapes (Step 1);
   - the four mcp-only tools and `jira_worklog_summary`: not served (an `isError` "Unknown tool" result, like an unlisted tool).
   - The double's own Jira requests go to the mock Jira, so `GET /rest/api/2/configuration` is served there (Task 4).

   Append an end-to-end test in the existing "through the double" `describe`, passing `outbound` (the test file already has an `outbound` policy from `./testing/scenario`):

```ts
  it('reads time tracking in hours, worklogs and a worklog summary through the double', async () => {
    const b = createMcpAtlassianBackend(
      { kind: 'datacenter_pat', baseUrl: dc.url, token: 'good-pat' },
      { url: double.url, outbound },
    );
    const issue = (await b.call('jira_get_issue', { issueKey: 'DEMO-1', commentLimit: 0 })) as { timeTracking: { originalEstimateHours: number | null } };
    expect(issue.timeTracking.originalEstimateHours).toBe(11.2);
    const log = (await b.call('jira_get_worklog', { issueKey: 'DEMO-1' })) as { totalHours: number };
    expect(log.totalHours).toBe(3);
    const s = (await b.call('jira_worklog_summary', { jql: 'project = DEMO' })) as { totalHours: number };
    expect(s.totalHours).toBe(7);
  });

  it('keeps the text when the setting cannot be read', async () => {
    const b = createMcpAtlassianBackend(
      { kind: 'datacenter_pat', baseUrl: dc.url, token: 'good-pat' },
      { url: double.url },
    );
    const issue = (await b.call('jira_get_issue', { issueKey: 'DEMO-2', commentLimit: 0 })) as { timeTracking: Record<string, unknown> };
    expect(issue.timeTracking).toMatchObject({ originalEstimate: '4d', originalEstimateHours: null, timeSpentHours: 4 });
  });
```

   (The second test passes no `outbound`, so no setting is read: `4d` has no hours, `4h` has. Because the setting cache is per Jira base URL and module-wide, run the "cannot be read" test against a backend with no `outbound`, which never consults the cache.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/jira-tools/src/mcp-backend.test.ts packages/jira-tools/src/rest-backend.test.ts && pnpm --filter @agile/jira-tools typecheck`
Expected: PASS. Existing double-based tests that compare whole issue objects need `timeTracking` in their expectations.

- [ ] **Step 5: Format and commit**

```bash
git add packages/jira-tools/src/mcp-backend.ts packages/jira-tools/src/mcp-backend.test.ts packages/jira-tools/src/index.ts packages/jira-tools/src/testing/mock-mcp-atlassian.ts
git commit -m "feat(jira-tools): mcp-atlassian backend maps time tracking, worklogs and metadata to one shape"
```

---

### Task 6: Allowlists in the deployments and the contract test

**Files:**
- Modify: `docker-compose.yml`, `docker-compose.selfhost.yml`, `deploy/helm/agile-copilot/templates/mcp-atlassian.yaml` (`ENABLED_TOOLS` of both instances)
- Modify: `packages/jira-tools/src/mcp-atlassian.contract.test.ts` (`SAMPLES`, local tool handling)
- Modify (only if the image needs it): `packages/jira/src/testing/mock-jira-server.ts`

**Interfaces:**
- Consumes: the generated `MCP_ATLASSIAN_ENABLED_TOOLS` and `MCP_ATLASSIAN_READONLY_ENABLED_TOOLS` (Task 2).
- Produces: deployment configuration in sync (existing `compose.test.ts`, `helm.test.ts`).

- [ ] **Step 1: See the sync tests fail**

Run: `pnpm vitest run packages/jira-tools/src/compose.test.ts && PATH="/tmp/helm-tools:$PATH" pnpm vitest run packages/jira-tools/src/helm.test.ts`
Expected: FAIL — the compose files' and the Helm template's `ENABLED_TOOLS` lack the new tools. (The Helm test needs helm; if it is not installed locally, `sh deploy/helm/check.sh` with `HELM_TOOLS_DIR=/tmp/helm-tools` downloads it, as in CI; if that is not possible on this machine, rely on the compose test and CI's `helm-kubeconform` job, and say so in the report.)

- [ ] **Step 2: Update the three files**

Set each read-write instance's `ENABLED_TOOLS` to `MCP_ATLASSIAN_ENABLED_TOOLS` and each read-only instance's to `MCP_ATLASSIAN_READONLY_ENABLED_TOOLS`, in the order and format the tests expect (print them with `pnpm exec tsx -e "import('@agile/jira-tools').then(m => { console.log(m.MCP_ATLASSIAN_ENABLED_TOOLS.join(',')); console.log(m.MCP_ATLASSIAN_READONLY_ENABLED_TOOLS.join(',')) })"` from `packages/agent`, or read them from the failing test's diff). Update the comments next to them if they name a tool count.

- [ ] **Step 3: The contract test**

In `packages/jira-tools/src/mcp-atlassian.contract.test.ts`:
- Add `SAMPLES` for the 11 new tools (valid inputs against the demo dataset: `DEMO-1`, project `DEMO`, board `1`, `jql: 'project = DEMO'`).
- In "serves exactly the enabled tools, and our arguments match their schemas", skip `JIRA_LOCAL_TOOLS` in the `for` loop (they have no mcp-atlassian tool).
- In "the read-only instance (background runs) has no write tools", compare against `READ_TOOLS` minus `JIRA_LOCAL_TOOLS` (or directly against `MCP_ATLASSIAN_READONLY_ENABLED_TOOLS`).
- "runs every allowlisted tool against Jira with the caller's PAT" keeps looping over all `JIRA_TOOL_NAMES` (the summary runs through the backend).
- Run it: `pnpm vitest run packages/jira-tools/src/mcp-atlassian.contract.test.ts` (pulls the pinned image; Docker must be running). For each new tool that fails because the mock Jira lacks an endpoint or a JQL form the real image calls, read the failing request in the mock's request log (or the container logs), add the minimal route or JQL support to `mock-jira-server.ts` with a test in `mock-jira-server.test.ts`, and rerun. A composite tool may legitimately return an empty result on the demo data; the test only requires `outcome: 'ok'`. If an argument we send is refused by the image's schema (e.g. `jql: 'ORDER BY Rank ASC'` for `jira_get_board_issues`), change that tool's `toMcp`/`fromMcp` in `catalog.ts` and its catalog test accordingly.
- The writes assertion at the end must stay exactly the same five writes: the new tools never write.

- [ ] **Step 4: Run everything in the package**

Run: `pnpm vitest run --project jira-tools && pnpm vitest run packages/jira/src/testing`
(If the Vitest project name differs, run `pnpm vitest run packages/jira-tools packages/jira/src/testing`.)
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
git add docker-compose.yml docker-compose.selfhost.yml deploy/helm/agile-copilot/templates/mcp-atlassian.yaml packages/jira-tools/src/mcp-atlassian.contract.test.ts
git commit -m "chore(deploy): allow the new read-only Jira tools in mcp-atlassian"
```

(Add `mock-jira-server.ts` / its test and `catalog.ts` / `catalog.test.ts` if you changed them, possibly as a separate `test(jira): …` commit.)

---

### Task 7: The agent offers the tools

**Files:**
- Modify: `packages/agent/src/tools.ts` (`buildJiraToolSet`)
- Modify: `packages/agent/src/prompt.ts` (live-Jira sentences in `systemPrompt` and `skillRunPrompt`)
- Modify: `apps/web/src/components/agent/tool-labels.ts`, `apps/web/messages/en.json`, `fr.json` (`agent.tools.*`)
- Test: `packages/agent/src/jira-offering.test.ts` (new), plus count updates in existing tests

**Interfaces:**
- Consumes: `isJiraMcpOnlyTool` from `@agile/jira-tools` (Task 2); `JiraSite.authType` (`'basic'` = REST, `'pat' | 'oauth'` = mcp-atlassian).
- Produces: nothing for later tasks.

- [ ] **Step 1: Write the failing tests**

`buildJiraToolSet(deps, actor, sites, mode)` is exported from `packages/agent/src/tools.ts` (check; export it if not, it is pure apart from `deps` used at execution). Create `packages/agent/src/jira-offering.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { AgentActor, AgentDeps } from './deps';
import { buildJiraToolSet, type JiraSite } from './tools';

const manager = { orgId: 'org', userId: 'u', roles: ['manager'] } as unknown as AgentActor;
const site = (id: string, authType: JiraSite['authType']): JiraSite =>
  ({ id, name: id, deployment: authType === 'pat' ? 'datacenter' : 'cloud', authType, usable: true }) as JiraSite;
const mode = { readOnly: true } as Parameters<typeof buildJiraToolSet>[3];
const names = (sites: JiraSite[]) => Object.keys(buildJiraToolSet({} as AgentDeps, manager, sites, mode));

describe('offering the Jira read tools', () => {
  it('offers the time tracking tools on every connection type', () => {
    expect(names([site('a', 'basic')])).toEqual(expect.arrayContaining(['jira_get_worklog', 'jira_worklog_summary']));
    expect(names([site('a', 'pat')])).toEqual(expect.arrayContaining(['jira_get_worklog', 'jira_worklog_summary']));
  });

  it('offers the mcp-only tools only when an mcp-atlassian site is usable', () => {
    expect(names([site('a', 'basic')])).not.toContain('jira_get_issue_dates');
    expect(names([site('a', 'pat')])).toContain('jira_get_issue_dates');
    expect(names([site('a', 'basic'), site('b', 'oauth')])).toContain('jira_search_fields');
  });

  it('limits the site choice of an mcp-only tool to mcp-atlassian sites', () => {
    const tools = buildJiraToolSet({} as AgentDeps, manager, [site('a', 'basic'), site('b', 'pat')], mode);
    const schema = tools.jira_get_issue_dates?.inputSchema as { safeParse(v: unknown): { success: boolean } };
    expect(schema.safeParse({ issueKey: 'DEMO-1', site: 'b' }).success).toBe(true);
    expect(schema.safeParse({ issueKey: 'DEMO-1', site: 'a' }).success).toBe(false);
  });

  it('gives viewers none of them', () => {
    const viewer = { ...manager, roles: ['viewer'] } as unknown as AgentActor;
    expect(Object.keys(buildJiraToolSet({} as AgentDeps, viewer, [site('a', 'pat')], mode))).toEqual([]);
  });
});
```

Adapt the `JiraSite`/`mode` construction to their real types in `tools.ts` (`PromptSite` fields, `JiraToolMode`) — the assertions are the requirement. If `inputSchema` is wrapped (e.g. by `tool()`), read the zod schema the way existing tests in `packages/agent/src` do.

Append to `packages/agent/src/suggest-skill.test.ts`'s prompt `describe` (or a new `prompt` test):

```ts
  it('tells the model about time tracking when live Jira is available', () => {
    const now = new Date('2026-10-05T12:00:00Z');
    expect(systemPrompt({ now, jiraSites: [], jira: 'read_only' })).toContain('jira_worklog_summary');
    expect(systemPrompt({ now, jiraSites: [], jira: 'unavailable' })).not.toContain('jira_worklog_summary');
    expect(skillRunPrompt({ now, liveJira: true, sites: [] })).toContain('jira_worklog_summary');
  });
```

(Use the real values of `JiraAccess` for "full" access too: the sentence goes in both the read-only and the read-write live-Jira branches.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/agent/src/jira-offering.test.ts packages/agent/src/suggest-skill.test.ts`
Expected: FAIL — mcp-only tools offered on a REST site; prompt lacks the sentence.

- [ ] **Step 3: Implement**

In `buildJiraToolSet` (`packages/agent/src/tools.ts`), import `isJiraMcpOnlyTool` from `@agile/jira-tools` and inside the `for (const name of JIRA_TOOL_NAMES)` loop, before building `inputSchema`:

```ts
    // Composite tools only mcp-atlassian runs: offered with the sites that use it, if any.
    const eligible = isJiraMcpOnlyTool(name) ? offered.filter((s) => s.authType !== 'basic') : offered;
    const [firstEligible] = eligible;
    if (!firstEligible) continue;
    const eligibleIds = eligible.map((s) => s.id) as [string, ...string[]];
```

and build the schema from them:

```ts
    const inputSchema =
      offered.length > 1
        ? def.input.extend({ site: z.enum(eligibleIds).describe('Jira site id (see system prompt)') })
        : def.input.transform((i) => ({ ...i, site: firstEligible.id }));
```

(`def.input` of `jira_worklog_summary` is a refined object: if `.extend` is not available on it, build the extended schema from the base object before `.refine` — move the refine into a shared helper in `catalog.ts` and export the unrefined shape, or apply `.and(z.object({ site: … }))`; keep the bounds and the from ≤ to check either way, and add a test that a summary call with `from > to` is still refused.)

In `execute`, after `if (!target.usable) …`, add:

```ts
        if (isJiraMcpOnlyTool(name) && target.authType === 'basic') throw new AgentToolError('not_supported');
```

In `packages/agent/src/prompt.ts`, add a constant and append it to the read-only and the read-write live-Jira texts in `systemPrompt`, and to the `liveJira` branch of `skillRunPrompt`:

```ts
const TIME_TRACKING = `Issue reads include time tracking (original and remaining estimate, time
spent) in hours and as Jira shows it; jira_get_worklog lists one issue's worklog entries;
jira_worklog_summary totals logged time per person and per issue for a JQL query in one call
(use it rather than reading many worklogs).`;
```

In `apps/web/src/components/agent/tool-labels.ts`, add the 11 names to `TOOL_LABELS`. In `en.json` / `fr.json` under `agent.tools`:

| key | en | fr |
|---|---|---|
| `jira_get_worklog` | Read worklogs | Lire le suivi du temps |
| `jira_worklog_summary` | Sum up logged time | Totaliser le temps passé |
| `jira_get_board_issues` | List board issues | Lister les tickets du tableau |
| `jira_get_issue_dates` | Read issue dates | Lire les dates du ticket |
| `jira_get_project_epic_hierarchy` | Read the epic hierarchy | Lire la hiérarchie des epics |
| `jira_get_cross_project_dependencies` | Read cross-project dependencies | Lire les dépendances entre projets |
| `jira_get_link_types` | List link types | Lister les types de liens |
| `jira_get_project_versions` | List versions | Lister les versions |
| `jira_get_project_components` | List components | Lister les composants |
| `jira_search_fields` | Find Jira fields | Rechercher des champs Jira |
| `jira_get_issue_watchers` | List watchers | Lister les observateurs |

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --project agent && pnpm vitest run --project web && pnpm --filter @agile/agent typecheck && pnpm --filter @agile/web typecheck`
Expected: PASS. Existing tests that pin the chat tool count or names (e.g. `packages/agent/src/providers.test.ts`, role tests listing Jira tools) need the new tools added; every provider adapter must still accept every tool schema (that test is the proof the new schemas are provider-safe).

- [ ] **Step 5: Format and commit**

```bash
git add packages/agent/src/tools.ts packages/agent/src/prompt.ts packages/agent/src/jira-offering.test.ts packages/agent/src/suggest-skill.test.ts apps/web/src/components/agent/tool-labels.ts apps/web/messages/en.json apps/web/messages/fr.json
git commit -m "feat(agent): offer the Jira time tracking and delivery-context read tools"
```

(Add the other test files you updated.)

---

### Task 8: End-to-end double and eval case

**Files:**
- Modify: `e2e/mocks/serve.ts` (only if it lists tools or datasets explicitly)
- Modify: `evals/script.ts`, `evals/tests/agent.yaml`

**Interfaces:**
- Consumes: the double (Task 5) and the mock Jira (Task 4), which `pnpm mocks` and the eval harness start.
- Produces: nothing for later tasks.

- [ ] **Step 1: Add the eval case**

Append to `evals/tests/agent.yaml`:

```yaml
- description: Totals logged time per person in one call (worklog summary)
  vars:
    question: How much time did each person log on the DEMO project?
  assert:
    - type: javascript
      value: |
        const m = context.providerResponse.metadata;
        return m.tools.includes('jira_worklog_summary') && /"totalHours"/.test(m.toolOutputs) && m.jiraWrites === 0;
    - type: icontains
      value: hours
```

- [ ] **Step 2: Teach the scripted model**

In `evals/script.ts` `evalScript`:
- after `const wantsSkill = …;` add `const wantsTime = /time did each person log|time logged/i.test(ask);`
- inside `if (last?.role === 'tool') {`, right after `const name = …;`:

```ts
    if (name === 'jira_worklog_summary') {
      const total = (payload(last) as { totalHours?: number })?.totalHours;
      return { text: `${total} hours were logged on DEMO.` };
    }
```

- before the `wantsSkill` request branch:

```ts
  if (wantsTime && tools.includes('jira_worklog_summary')) {
    return { toolCalls: [{ name: 'jira_worklog_summary', args: { jql: 'project = DEMO' } }] };
  }
```

Check `e2e/mocks/serve.ts`: if it builds the mock Jira with `demoDataset(...)`, nothing to change (the dataset now has worklogs). If the eval's agent provider runs the scripted model against the mcp double, `jira_worklog_summary` is computed by our backend through the double's `jira_search` + `jira_get_worklog`; nothing else to wire.

- [ ] **Step 3: Verify**

Run: `pnpm --filter @agile/evals typecheck`
Then run the evals as in the previous feature: from Git Bash, `cd evals && PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_DISABLE_UPDATE=1 npx -y pnpm@10.14.0 dlx promptfoo@0.123.1 eval -c promptfooconfig.yaml --no-cache --no-progress-bar --no-write` (Docker running; promptfoo is cached from the last run).
Expected: every test passes, including the new one.

- [ ] **Step 4: Format and commit**

```bash
git add evals/script.ts evals/tests/agent.yaml
git commit -m "test(evals): the scripted assistant totals logged time with the worklog summary"
```

---

### Task 9: Verify and deliver

**Files:** none.

- [ ] **Step 1: Full checks**

Run: `pnpm --filter @agile/jira-tools typecheck && pnpm --filter @agile/jira typecheck && pnpm --filter @agile/agent typecheck && pnpm --filter @agile/web typecheck && pnpm --filter @agile/evals typecheck`
Run: `pnpm vitest run --project jira-tools --project jira --project agent --project web --project worker`
Expected: PASS (database tests use Testcontainers; rerun a timed-out file alone before concluding).

- [ ] **Step 2: Restart the dev containers with the new allowlist**

`docker compose up -d --force-recreate mcp-atlassian mcp-atlassian-readonly`, then confirm `docker compose exec -T mcp-atlassian printenv ENABLED_TOOLS` lists `jira_get_worklog`. Restart `pnpm dev`.

- [ ] **Step 3: Manual check with the real model and Data Center Jira (the user)**

At http://localhost:3000/agent:
1. "What is the original estimate and the time spent on AIA-1086?" → about 11.2 h estimated, 14 h spent (with Jira's own text).
2. "Show me the worklogs of AIA-1086" → entries with people, dates and hours.
3. "How much time did each person log in the current sprint?" → one `jira_worklog_summary` call, totals per person.
4. A question needing a composite tool, e.g. "What are the status changes of AIA-1091?" → `jira_get_issue_dates`.

- [ ] **Step 4: Merge locally into develop**

```bash
git switch develop
git merge --no-ff feat/jira-read-tools -m "Merge branch 'feat/jira-read-tools' into develop"
```
