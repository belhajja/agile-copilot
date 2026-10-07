# Dashboard Sprint Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sprint picker on the board dashboard that scopes every sprint-based and time-based widget to one sprint or compares several.

**Architecture:** The selection lives in the URL (`?sprints=<id>,<id>`). The board page parses it against the board's synced sprints and passes an optional `scope` to `computeWidget`; without a scope every widget is computed exactly as today. Sprint widgets compute per selected sprint (with a per-sprint breakdown or one chart line per sprint); time-based widgets get the selection's period converted into the window inputs the existing metric functions already take; forecasts and current-state widgets are flagged `unfiltered`.

**Tech Stack:** TypeScript, Next.js 16 (server components + one client picker), Vitest, Biome, next-intl, shadcn/radix (`radix-ui` 1.6.7).

**Spec:** `docs/superpowers/specs/2026-10-07-dashboard-sprint-filter-design.md`

## Global Constraints

- URL parameter: `sprints`, comma-separated sprint ids (`MetricSprint.id`, the `jira_sprints.id` uuid); 1 to 10 sprints.
- Without a selection, every widget's output must be identical to today's.
- Chronological order everywhere: start date, sprints without a start date last, then name.
- The selection's period: earliest start → latest (completeAt ?? endAt ?? now), capped at `now`; sprints without a start date do not count.
- Forecasts (`forecast_how_many`, `forecast_when`), `wip`, `aging_wip`, `hygiene`: computed as today, flagged `unfiltered: true` (shown as "Not filtered by sprint").
- No database change; stored widgets, `pin_widget` and default dashboards unchanged.
- All new UI text in English and French; message keys listed in `apps/web/src/components/dashboard/message-keys.ts` (a test ties the lists to both message files).
- Commits: one subject line, no body, no trailer of any kind.

## Review Focus

1. A URL with sprint ids of another board (or garbage, duplicates, more than 10) → ignored silently; never an error page. Test: Task 2, "keeps only this board's sprints, unique, at most 10".
2. Only future sprints selected → sprint widgets show `no_sprint`, time-based ones `no_data`; no crash. Test: Task 3, "only future sprints", and Task 4, "a selection without dates".
3. An active sprint selected → velocity shows its progress so far, average/say-do ignore it. Test: Task 1 "active sprint: completed so far", Task 3 "average velocity leaves active sprints out".
4. A selection spanning several months → time-based widgets cover the whole period (window not capped at the widget's stored default). Test: Task 4, "uses the whole selection period".
5. Clearing the picker → URL without `sprints`, page identical to today. Test: Task 6, "clearing removes the parameter".

---

### Task 1: Per-sprint velocity in the metrics package

**Files:**
- Modify: `packages/metrics/src/scrum.ts` (add `sprintVelocity`, make `velocity` use it)
- Modify: `packages/metrics/src/index.ts` (export `sprintVelocity`, `startOfUtcWeek`, `eachUtcDay`)
- Modify: `packages/metrics/package.json` (export `./testing` → `./src/fixtures.ts`)
- Test: `packages/metrics/src/scrum.test.ts`

**Interfaces:**
- Produces: `sprintVelocity(ds: BoardDataset, sprint: MetricSprint, opts: { unit?: Unit; now: Date }): SprintVelocity | null` — closed sprint: committed at start vs completed at close (today's rule); active sprint: committed at start vs done at `now` among its members at `now` (not done at start); future or no start date: `null`. Exports `startOfUtcWeek(d: Date): Date` and `eachUtcDay(from: Date, to: Date): Date[]` from the package root. `@agile/metrics/testing` exports `d`, `issue`, `scrumFixture`, `flowFixture`, `T0`.

- [ ] **Step 1: Write the failing tests** (append to `packages/metrics/src/scrum.test.ts`, inside the existing `describe('scrum metrics (golden: scrumFixture)'`, and add `sprintVelocity` to the `./scrum` import)

```ts
  it('sprintVelocity: a closed sprint gives the same row as velocity()', () => {
    expect(sprintVelocity(ds, sprint, { now: d(20) })).toEqual(velocity(ds)[0]);
  });

  it('active sprint: completed so far', () => {
    // At d5 only A (5 pts) is done; committed is still A5 + B2 + C8 + D2 = 17.
    const active = { ...sprint, state: 'active' as const, completeAt: null };
    expect(sprintVelocity(ds, active, { now: d(5) })).toEqual({
      sprintId: 's1',
      name: 'Sprint 1',
      committed: 17,
      completed: 5,
      committedCount: 4,
      completedCount: 1,
    });
  });

  it('future sprint or no start date: no velocity', () => {
    const future = { ...sprint, state: 'future' as const, startAt: null, completeAt: null };
    expect(sprintVelocity(ds, future, { now: d(20) })).toBeNull();
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run packages/metrics/src/scrum.test.ts`
Expected: FAIL, `sprintVelocity` is not exported.

- [ ] **Step 3: Implement** — in `packages/metrics/src/scrum.ts`, replace the body of `velocity` and add `sprintVelocity` right after it:

```ts
export function velocity(
  ds: BoardDataset,
  opts: { sprints?: number; unit?: Unit } = {},
): SprintVelocity[] {
  const requested = opts.sprints ?? 6;
  const count = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 6;
  return closedSprints(ds)
    .slice(-count)
    .flatMap((s) => {
      const row = sprintVelocity(ds, s, { unit: opts.unit, now: s.completeAt });
      return row ? [row] : [];
    });
}

/**
 * Committed vs completed for one sprint. Closed: completed at close (as velocity()). Active:
 * completed so far, among the issues in the sprint at `now`. Future or never started: null.
 */
export function sprintVelocity(
  ds: BoardDataset,
  sprint: MetricSprint,
  opts: { unit?: Unit; now: Date },
): SprintVelocity | null {
  if (!sprint.startAt || sprint.state === 'future') return null;
  if (sprint.state === 'closed' && !sprint.completeAt) return null;
  const unit = opts.unit ?? 'points';
  const byId = indexIssues(ds.issues);
  const start = sprint.startAt;
  const end = sprint.completeAt ?? opts.now;
  const committed = committedIssues({ ...sprint, startAt: start }, byId);
  const members = sprint.completeAt
    ? closeMembers({ ...sprint, completeAt: sprint.completeAt }, byId)
    : pick(membersAt(sprint, end), byId);
  const done = members.filter(
    (i) => categoryAt(i, end) === 'done' && categoryAt(i, start) !== 'done',
  );
  return {
    sprintId: sprint.id,
    name: sprint.name,
    committed: total(committed.map((i) => valueAt(i, start, unit))),
    completed: total(done.map((i) => valueAt(i, end, unit))),
    committedCount: committed.length,
    completedCount: done.length,
  };
}
```

In `packages/metrics/src/index.ts`, add `sprintVelocity` to the `./scrum` export list and change the time export to:

```ts
export { addDays, DAY, eachUtcDay, isoDay, startOfUtcDay, startOfUtcWeek } from './time';
```

In `packages/metrics/package.json`, `exports` becomes:

```json
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/fixtures.ts"
  },
```

- [ ] **Step 4: Run the metrics tests to see them pass**

Run: `npx vitest run --project metrics && (cd packages/metrics && npx tsc --noEmit -p tsconfig.json)`
Expected: all metrics tests PASS (the existing `velocity` golden tests prove the refactor kept today's output).

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/metrics
git add packages/metrics
git commit -m "feat(metrics): compute velocity for one sprint, active ones included"
```

---

### Task 2: Reading the selection and its period

**Files:**
- Create: `packages/dashboards/src/sprint-scope.ts`
- Modify: `packages/dashboards/src/index.ts` (export the new names)
- Test: `packages/dashboards/src/sprint-scope.test.ts`

**Interfaces:**
- Consumes: `MetricSprint` from `@agile/metrics`.
- Produces: `MAX_SELECTED_SPRINTS = 10`; `interface SprintScope { sprints: MetricSprint[] }`; `bySprintDate(a: MetricSprint, b: MetricSprint): number`; `parseSprintSelection(raw: string | string[] | undefined, boardSprints: readonly MetricSprint[]): MetricSprint[]` (chronological, may be empty); `selectionPeriod(sprints: readonly MetricSprint[], now: Date): { from: Date; to: Date } | null`.

- [ ] **Step 1: Write the failing tests** — `packages/dashboards/src/sprint-scope.test.ts`:

```ts
import type { MetricSprint } from '@agile/metrics';
import { d } from '@agile/metrics/testing';
import { describe, expect, it } from 'vitest';
import { MAX_SELECTED_SPRINTS, parseSprintSelection, selectionPeriod } from './sprint-scope';

const sprint = (id: string, over: Partial<MetricSprint> = {}): MetricSprint => ({
  id,
  name: `Sprint ${id}`,
  state: 'closed',
  startAt: d(0),
  endAt: d(10),
  completeAt: d(10),
  members: [],
  ...over,
});

describe('parseSprintSelection', () => {
  const s76 = sprint('76', { startAt: d(0), endAt: d(14), completeAt: d(14) });
  const s77 = sprint('77', { startAt: d(14), endAt: d(28), completeAt: null, state: 'active' });
  const s78 = sprint('78', { startAt: null, endAt: null, completeAt: null, state: 'future' });
  const board = [s78, s77, s76];

  it('no parameter or an empty one means no filter', () => {
    expect(parseSprintSelection(undefined, board)).toEqual([]);
    expect(parseSprintSelection('', board)).toEqual([]);
    expect(parseSprintSelection(' , ', board)).toEqual([]);
  });

  it('keeps only this board\'s sprints, unique, at most 10', () => {
    expect(parseSprintSelection('77,other-board,77, 76 ', board).map((s) => s.id)).toEqual([
      '76',
      '77',
    ]);
    const many = Array.from({ length: 15 }, (_, i) => sprint(`x${i}`, { startAt: d(i) }));
    const raw = many.map((s) => s.id).join(',');
    expect(parseSprintSelection(raw, many)).toHaveLength(MAX_SELECTED_SPRINTS);
    expect(parseSprintSelection(raw, many)[0]?.id).toBe('x0');
  });

  it('accepts the array form and sorts by date, undated sprints last', () => {
    expect(parseSprintSelection(['78,77', '76'], board).map((s) => s.id)).toEqual([
      '76',
      '77',
      '78',
    ]);
  });
});

describe('selectionPeriod', () => {
  it('spans the earliest start to the latest end, using complete, end, then now', () => {
    const closed = sprint('a', { startAt: d(0), endAt: d(12), completeAt: d(10) });
    const active = sprint('b', { startAt: d(14), endAt: d(28), completeAt: null, state: 'active' });
    expect(selectionPeriod([closed], d(40))).toEqual({ from: d(0), to: d(10) });
    expect(selectionPeriod([closed, active], d(40))).toEqual({ from: d(0), to: d(28) });
    expect(selectionPeriod([closed, active], d(20))).toEqual({ from: d(0), to: d(20) });
  });

  it('a selection without dates has no period', () => {
    const future = sprint('f', { startAt: null, endAt: null, completeAt: null, state: 'future' });
    expect(selectionPeriod([future], d(20))).toBeNull();
    expect(selectionPeriod([], d(20))).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run packages/dashboards/src/sprint-scope.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** — `packages/dashboards/src/sprint-scope.ts`:

```ts
import type { MetricSprint } from '@agile/metrics';

/** Sprints a dashboard can compare at once. */
export const MAX_SELECTED_SPRINTS = 10;

/** The sprints a dashboard is scoped to (non-empty, chronological). */
export interface SprintScope {
  sprints: MetricSprint[];
}

/** Chronological: start date, sprints never started last, then name. */
export function bySprintDate(a: MetricSprint, b: MetricSprint): number {
  const at = a.startAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bt = b.startAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return at - bt || a.name.localeCompare(b.name, undefined, { numeric: true });
}

/**
 * The `sprints` URL parameter (comma-separated ids, or several values) resolved against the
 * board's sprints: unknown ids (another board's, a typo) are dropped, duplicates too, at most
 * MAX_SELECTED_SPRINTS in URL order. Empty means no filter.
 */
export function parseSprintSelection(
  raw: string | string[] | undefined,
  boardSprints: readonly MetricSprint[],
): MetricSprint[] {
  const byId = new Map(boardSprints.map((s) => [s.id, s]));
  const ids = (Array.isArray(raw) ? raw : [raw ?? ''])
    .flatMap((part) => part.split(','))
    .map((id) => id.trim())
    .filter((id) => byId.has(id));
  return [...new Set(ids)]
    .slice(0, MAX_SELECTED_SPRINTS)
    .flatMap((id) => {
      const s = byId.get(id);
      return s ? [s] : [];
    })
    .sort(bySprintDate);
}

/**
 * From the earliest start to the latest end of the selected sprints (end = complete date, else
 * planned end, else now), capped at now. Sprints never started do not count; none started: null.
 */
export function selectionPeriod(
  sprints: readonly MetricSprint[],
  now: Date,
): { from: Date; to: Date } | null {
  const started = sprints.filter((s): s is MetricSprint & { startAt: Date } => s.startAt !== null);
  if (started.length === 0) return null;
  const from = Math.min(...started.map((s) => s.startAt.getTime()));
  const end = Math.max(...started.map((s) => (s.completeAt ?? s.endAt ?? now).getTime()));
  return { from: new Date(from), to: new Date(Math.min(end, now.getTime())) };
}
```

In `packages/dashboards/src/index.ts` add:

```ts
export {
  bySprintDate,
  MAX_SELECTED_SPRINTS,
  parseSprintSelection,
  type SprintScope,
  selectionPeriod,
} from './sprint-scope';
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run packages/dashboards/src/sprint-scope.test.ts && (cd packages/dashboards && npx tsc --noEmit -p tsconfig.json)`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/dashboards
git add packages/dashboards
git commit -m "feat(dashboards): read a sprint selection from the URL and its period"
```

---

### Task 3: Sprint widgets follow the selection

**Files:**
- Modify: `packages/dashboards/src/widget-data.ts` (KPI `breakdown`, series `label`, `unfiltered`)
- Modify: `packages/dashboards/src/compute.ts` (optional `scope`, scoped sprint metrics)
- Test: `packages/dashboards/src/compute-scope.test.ts`

**Interfaces:**
- Consumes: `sprintVelocity`, `velocitySummary`, `scopeChange`, `carryOver`, `sprintBurn` (Task 1 and existing); `SprintScope` (Task 2).
- Produces: `computeWidget(spec: WidgetSpec, ds: BoardDataset, now: Date, scope?: SprintScope): WidgetData`. `WidgetData` additions: every kind may carry `unfiltered?: true`; KPI: `breakdown?: { label: string; value: number | null }[]`; series entries: `label?: string`. New hint keys emitted: `selectedSprints` (`{ count }`), `finishedInSelection` (`{ count }`).

- [ ] **Step 1: Write the failing tests** — `packages/dashboards/src/compute-scope.test.ts`:

```ts
import type { BoardDataset, MetricSprint } from '@agile/metrics';
import { d, scrumFixture } from '@agile/metrics/testing';
import { describe, expect, it } from 'vitest';
import { computeWidget } from './compute';
import { widgetSpecSchema } from './widget-spec';

const NOW = d(40);
const spec = (w: object) => widgetSpecSchema.parse(w);
const ds: BoardDataset = scrumFixture();
const s1 = ds.sprints[0] as MetricSprint;
// A copy of Sprint 1 under another name: same numbers, so every expected value below comes from
// the scrumFixture golden values (velocity 17 committed / 9 completed, scope +1, carry-over 1).
const s2: MetricSprint = { ...s1, id: 's2', name: 'Sprint 2' };
const future: MetricSprint = {
  ...s1,
  id: 's3',
  name: 'Sprint 3',
  state: 'future',
  startAt: null,
  endAt: null,
  completeAt: null,
};
const all: BoardDataset = { ...ds, sprints: [s1, s2, future] };
const scope = (...sprints: MetricSprint[]) => ({ sprints });

describe('computeWidget with a sprint selection', () => {
  it('velocity: one bar pair per selected sprint, future ones skipped', () => {
    const data = computeWidget(spec({ id: 'v', metric: 'velocity', chart: 'bar' }), all, NOW, scope(s1, s2, future));
    expect(data).toMatchObject({
      kind: 'series',
      rows: [
        { sprint: 'Sprint 1', committed: 17, completed: 9 },
        { sprint: 'Sprint 2', committed: 17, completed: 9 },
      ],
    });
  });

  it('average velocity over the selection, with a per-sprint breakdown', () => {
    const data = computeWidget(spec({ id: 'a', metric: 'average_velocity', chart: 'kpi' }), all, NOW, scope(s1, s2));
    expect(data).toEqual({
      kind: 'kpi',
      value: 9,
      format: 'points',
      hint: { key: 'selectedSprints', values: { count: 2 } },
      breakdown: [
        { label: 'Sprint 1', value: 9 },
        { label: 'Sprint 2', value: 9 },
      ],
    });
  });

  it('one sprint: its own value, no breakdown', () => {
    const data = computeWidget(spec({ id: 's', metric: 'say_do_ratio', chart: 'kpi' }), all, NOW, scope(s1));
    expect(data).toEqual({
      kind: 'kpi',
      value: 0.5294,
      format: 'percent',
      hint: { key: 'selectedSprints', values: { count: 1 } },
    });
  });

  it('average velocity leaves active sprints out', () => {
    const active: MetricSprint = { ...s2, state: 'active', completeAt: null };
    const data = computeWidget(spec({ id: 'a', metric: 'average_velocity', chart: 'kpi' }), { ...ds, sprints: [s1, active] }, NOW, scope(s1, active));
    expect(data).toMatchObject({ kind: 'kpi', value: 9, hint: { values: { count: 1 } } });
  });

  it('scope change and carry-over: the latest sprint, every sprint in the breakdown', () => {
    expect(
      computeWidget(spec({ id: 'c', metric: 'scope_change', chart: 'kpi' }), all, NOW, scope(s1, s2)),
    ).toMatchObject({
      kind: 'kpi',
      value: 1,
      hint: { key: 'scopeRemoved', values: { removed: 2, sprint: 'Sprint 2' } },
      breakdown: [
        { label: 'Sprint 1', value: 1 },
        { label: 'Sprint 2', value: 1 },
      ],
    });
    expect(
      computeWidget(spec({ id: 'o', metric: 'carry_over', chart: 'kpi' }), all, NOW, scope(s1)),
    ).toEqual({
      kind: 'kpi',
      value: 1,
      format: 'issues',
      hint: { key: 'carriedFrom', values: { sprint: 'Sprint 1' } },
    });
  });

  it('burndown: the sprint as today for one, one line per sprint by sprint day for several', () => {
    const burn = spec({ id: 'b', metric: 'sprint_burndown', chart: 'line' });
    const single = computeWidget(burn, all, NOW, scope(s1));
    expect(single).toMatchObject({ kind: 'series', x: 'day', series: [{ key: 'remaining' }, { key: 'ideal', dashed: true }] });
    const several = computeWidget(burn, all, NOW, scope(s1, s2));
    expect(several).toMatchObject({
      kind: 'series',
      chart: 'line',
      x: 'day',
      series: [
        { key: 's0', label: 'Sprint 1' },
        { key: 's1', label: 'Sprint 2' },
      ],
    });
    if (several.kind !== 'series') throw new Error('series');
    // Sprint 1 runs from d0 09:00 to d10 09:00: 11 UTC days, day 1 … day 11.
    expect(several.rows).toHaveLength(11);
    expect(several.rows[0]).toMatchObject({ day: 'd1' });
    expect(several.rows[0]?.s0).toBe(several.rows[0]?.s1);
  });

  it('only future sprints: nothing to show', () => {
    for (const w of [
      { id: 'v', metric: 'velocity', chart: 'bar' },
      { id: 'a', metric: 'average_velocity', chart: 'kpi' },
      { id: 'c', metric: 'scope_change', chart: 'kpi' },
      { id: 'o', metric: 'carry_over', chart: 'kpi' },
      { id: 'b', metric: 'sprint_burnup', chart: 'line' },
    ]) {
      expect(computeWidget(spec(w), all, NOW, scope(future))).toEqual({ kind: 'empty', reason: 'no_sprint' });
    }
  });

  it('no selection: the same output as today', () => {
    for (const w of [
      { id: 'v', metric: 'velocity', chart: 'bar' },
      { id: 'a', metric: 'average_velocity', chart: 'kpi' },
      { id: 'b', metric: 'sprint_burndown', chart: 'line' },
    ]) {
      expect(computeWidget(spec(w), all, NOW, undefined)).toEqual(computeWidget(spec(w), all, NOW));
      expect(computeWidget(spec(w), all, NOW, { sprints: [] })).toEqual(computeWidget(spec(w), all, NOW));
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run packages/dashboards/src/compute-scope.test.ts`
Expected: FAIL (the scope argument is ignored: rows/hints differ).

- [ ] **Step 3: Extend `packages/dashboards/src/widget-data.ts`** — the full union becomes:

```ts
/** Set when a sprint selection is active but this widget cannot follow it (shown as a note). */
type Unfiltered = { unfiltered?: true };

export type WidgetData = Unfiltered &
  (
    | {
        kind: 'kpi';
        value: number | null;
        format: KpiFormat;
        /** Optional footnote (message key under dashboard.hints) with interpolation values. */
        hint?: { key: string; values?: Record<string, string | number> };
        /** Selected sprints compared: each sprint's own value (label = sprint name, shown as is). */
        breakdown?: { label: string; value: number | null }[];
      }
    | {
        kind: 'series';
        chart: 'bar' | 'line' | 'area';
        /** Row field holding the x value (a yyyy-mm-dd day or a label). */
        x: string;
        /** `label`: a literal display name (a sprint's), used instead of the key's message. */
        series: { key: string; label?: string; stacked?: boolean; dashed?: boolean }[];
        rows: Record<string, string | number | null>[];
      }
    | {
        kind: 'table';
        /** `code`/`codes` cells hold message keys (dashboard.codes.*) the UI translates. */
        columns: { key: string; type: 'text' | 'number' | 'days' | 'date' | 'code' | 'codes' }[];
        rows: (string | number | null)[][];
        /** Forecast tables: a percentile hit the simulation's day cap, so the real answer is later. */
        capped?: boolean;
        maxDays?: number;
      }
    | { kind: 'empty'; reason: 'no_sprint' | 'no_data' | 'no_estimates' }
  );
```

- [ ] **Step 4: Implement the scoped sprint widgets in `packages/dashboards/src/compute.ts`**

Add `sprintVelocity` to the `@agile/metrics` import and `import type { SprintScope } from './sprint-scope';`. Change the signature and add the scoped entry point at the top of `computeWidget`:

```ts
export function computeWidget(
  spec: WidgetSpec,
  ds: BoardDataset,
  now: Date,
  scope?: SprintScope,
): WidgetData {
  if (scope && scope.sprints.length > 0) {
    const scoped = computeScoped(spec, ds, now, scope.sprints);
    if (scoped) return scoped;
  }
  switch (spec.metric) {
```

Move today's burn branch into a helper (and call it from the existing `case 'sprint_burndown': case 'sprint_burnup':` with the picked sprint, so today's output is unchanged):

```ts
function burnFor(
  metric: 'sprint_burndown' | 'sprint_burnup',
  ds: BoardDataset,
  sprint: MetricSprint,
  unit: Unit,
  now: Date,
): WidgetData {
  const rows = sprintBurn(ds, sprint, { unit, now });
  if (!rows || rows.length === 0) return empty('no_sprint');
  return metric === 'sprint_burndown'
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
```

The existing case becomes:

```ts
    case 'sprint_burndown':
    case 'sprint_burnup': {
      const sprint = pickSprint(ds, spec.params.sprint);
      if (!sprint) return empty('no_sprint');
      return burnFor(spec.metric, ds, sprint, unitFor(ds, spec.params.unit), now);
    }
```

Add the scoped computation (sprint metrics here; time-based ones and `unfiltered` come in Task 4 — until then they return `null` and fall through to today's computation):

```ts
const ratio = (completed: number, committed: number) =>
  committed > 0 ? Math.round((completed / committed) * 10_000) / 10_000 : null;

/** Several values: each sprint's own, for the KPI card. One value: none. */
const breakdownOf = (items: { label: string; value: number | null }[]) =>
  items.length > 1 ? { breakdown: items } : {};

/** Widgets scoped to the selected sprints (chronological); null: not sprint-scoped here. */
function computeScoped(
  spec: WidgetSpec,
  ds: BoardDataset,
  now: Date,
  sprints: MetricSprint[],
): WidgetData | null {
  switch (spec.metric) {
    case 'average_velocity':
    case 'say_do_ratio': {
      const unit = unitFor(ds, spec.params.unit);
      const rows = sprints
        .filter((s) => s.state === 'closed')
        .flatMap((s) => {
          const row = sprintVelocity(ds, s, { unit, now });
          return row ? [row] : [];
        });
      if (rows.length === 0) return empty('no_sprint');
      const summary = velocitySummary(rows);
      const hint = { key: 'selectedSprints', values: { count: rows.length } };
      return spec.metric === 'average_velocity'
        ? {
            kind: 'kpi',
            value: summary.average,
            format: unit,
            hint,
            ...breakdownOf(rows.map((r) => ({ label: r.name, value: r.completed }))),
          }
        : {
            kind: 'kpi',
            value: summary.sayDoRatio,
            format: 'percent',
            hint,
            ...breakdownOf(rows.map((r) => ({ label: r.name, value: ratio(r.completed, r.committed) }))),
          };
    }
    case 'velocity': {
      const unit = unitFor(ds, spec.params.unit);
      const rows = sprints.flatMap((s) => {
        const row = sprintVelocity(ds, s, { unit, now });
        return row ? [row] : [];
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
      const unit = unitFor(ds, spec.params.unit);
      const changes = sprints.flatMap((s) => {
        const c = scopeChange(ds, s, { unit, now });
        return c ? [c] : [];
      });
      const last = changes.at(-1);
      if (!last) return empty('no_sprint');
      return {
        kind: 'kpi',
        value: last.added,
        format: unit,
        hint: { key: 'scopeRemoved', values: { removed: last.removed, sprint: last.name } },
        ...breakdownOf(changes.map((c) => ({ label: c.name, value: c.added }))),
      };
    }
    case 'carry_over': {
      const results = sprints.flatMap((s) => {
        const c = carryOver(ds, s);
        return c ? [c] : [];
      });
      const last = results.at(-1);
      if (!last) return empty('no_sprint');
      return {
        kind: 'kpi',
        value: last.count,
        format: 'issues',
        hint: { key: 'carriedFrom', values: { sprint: last.name } },
        ...breakdownOf(results.map((c) => ({ label: c.name, value: c.count }))),
      };
    }
    case 'sprint_burndown':
    case 'sprint_burnup': {
      const unit = unitFor(ds, spec.params.unit);
      const burns = sprints.flatMap((s) => {
        const rows = sprintBurn(ds, s, { unit, now });
        return rows && rows.length > 0 ? [{ sprint: s, rows }] : [];
      });
      const first = burns[0];
      if (!first) return empty('no_sprint');
      if (burns.length === 1) return burnFor(spec.metric, ds, first.sprint, unit, now);
      const value = (r: BurnRow) => (spec.metric === 'sprint_burndown' ? r.remaining : r.completed);
      const days = Math.max(...burns.map((b) => b.rows.length));
      return {
        kind: 'series',
        chart: 'line',
        x: 'day',
        series: burns.map((b, i) => ({ key: `s${i}`, label: b.sprint.name })),
        rows: Array.from({ length: days }, (_, day) => ({
          day: `d${day + 1}`,
          ...Object.fromEntries(
            burns.map((b, i) => {
              const row = b.rows[day];
              return [`s${i}`, row ? value(row) : null];
            }),
          ),
        })),
      };
    }
    default:
      return null;
  }
}
```

(Import `type BurnRow` from `@agile/metrics`.)

- [ ] **Step 5: Run the dashboards tests**

Run: `npx vitest run --project dashboards && (cd packages/dashboards && npx tsc --noEmit -p tsconfig.json)`
Expected: PASS, including every existing compute/demo test (unscoped output unchanged).

- [ ] **Step 6: Commit**

```bash
npx biome check --write packages/dashboards
git add packages/dashboards
git commit -m "feat(dashboards): scope sprint widgets to the selected sprints"
```

---

### Task 4: Time-based widgets use the selection's period

**Files:**
- Modify: `packages/dashboards/src/compute.ts` (`computeScoped`: time-based cases, `unfiltered`)
- Test: `packages/dashboards/src/compute-scope.test.ts` (append)

**Interfaces:**
- Consumes: `selectionPeriod` (Task 2); `eachUtcDay`, `startOfUtcWeek`, `DAY` from `@agile/metrics` (Task 1).
- Produces: scoped results for `cycle_time`, `lead_time`, `flow_efficiency`, `throughput`, `throughput_rate`, `wip_trend`, `cfd`; `unfiltered: true` on `forecast_how_many`, `forecast_when`, `wip`, `aging_wip`, `hygiene`.

- [ ] **Step 1: Write the failing tests** (append inside the describe of `compute-scope.test.ts`; add `cycleTime`, `weeklyThroughput`, `wipSeries` from `@agile/metrics` to the imports)

```ts
  it('cycle time over the selected sprint\'s period', () => {
    // Sprint 1: d0 09:00 → d10 09:00. Done inside: A (d3), E (d6), B (d8).
    const data = computeWidget(spec({ id: 'c', metric: 'cycle_time', chart: 'kpi' }), all, NOW, scope(s1));
    const expected = cycleTime(all, { windowDays: 10, now: d(10, 9) });
    expect(expected.count).toBe(3);
    expect(data).toEqual({
      kind: 'kpi',
      value: expected.p85,
      format: 'days',
      hint: { key: 'finishedInSelection', values: { count: 3 } },
    });
  });

  it('uses the whole selection period', () => {
    const late: MetricSprint = { ...s1, id: 's9', name: 'Sprint 9', startAt: d(60), endAt: d(74), completeAt: d(74) };
    const wide: BoardDataset = { ...ds, sprints: [s1, late] };
    const data = computeWidget(spec({ id: 'w', metric: 'wip_trend', chart: 'line' }), wide, d(90), scope(s1, late));
    if (data.kind !== 'series') throw new Error('series');
    // d0 → d74 inclusive: 75 UTC days, far beyond the widget's own 30.
    expect(data.rows).toHaveLength(75);
    expect(data.rows).toEqual(wipSeries(wide, { days: 75, now: d(74) }).map((r) => ({ day: r.day, wip: r.wip })));
    const weeks = computeWidget(spec({ id: 't', metric: 'throughput', chart: 'bar' }), wide, d(90), scope(s1, late));
    if (weeks.kind !== 'series') throw new Error('series');
    expect(weeks.rows.map((r) => r.week)).toEqual(weeklyThroughput(wide, { weeks: 11, now: d(74) }).map((r) => r.weekStart));
  });

  it('a selection without dates: time-based widgets have no data', () => {
    expect(computeWidget(spec({ id: 'c', metric: 'cycle_time', chart: 'kpi' }), all, NOW, scope(future))).toEqual({
      kind: 'empty',
      reason: 'no_data',
    });
  });

  it('forecasts and current-state widgets are computed as today and flagged', () => {
    for (const w of [
      { id: 'f', metric: 'forecast_how_many', chart: 'table' },
      { id: 'w', metric: 'wip', chart: 'kpi' },
      { id: 'h', metric: 'hygiene', chart: 'table' },
    ]) {
      expect(computeWidget(spec(w), all, NOW, scope(s1))).toEqual({
        ...computeWidget(spec(w), all, NOW),
        unfiltered: true,
      });
    }
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run packages/dashboards/src/compute-scope.test.ts`
Expected: FAIL (time-based widgets ignore the scope; no `unfiltered`).

- [ ] **Step 3: Implement** — in `computeScoped`, before `default:`, add (import `DAY`, `eachUtcDay`, `startOfUtcWeek` from `@agile/metrics` and `selectionPeriod` from `./sprint-scope`):

```ts
    case 'cycle_time':
    case 'lead_time':
    case 'flow_efficiency':
    case 'throughput':
    case 'throughput_rate':
    case 'wip_trend':
    case 'cfd':
      return computeForPeriod(spec, ds, now, sprints);
    case 'forecast_how_many':
    case 'forecast_when':
    case 'wip':
    case 'aging_wip':
    case 'hygiene':
      return { ...computeWidget(spec, ds, now), unfiltered: true };
```

and the helper (the period becomes the inputs the metric functions already take: `now` = the period's end, the window = its length):

```ts
/** Time-based widgets over the selected sprints' period instead of their own trailing window. */
function computeForPeriod(
  spec: WidgetSpec,
  ds: BoardDataset,
  now: Date,
  sprints: MetricSprint[],
): WidgetData {
  const period = selectionPeriod(sprints, now);
  if (!period) return empty('no_data');
  const end = period.to;
  const windowDays = Math.max(1, Math.ceil((end.getTime() - period.from.getTime()) / DAY));
  const calendarDays = eachUtcDay(period.from, end).length;
  const weeks =
    Math.round((startOfUtcWeek(end).getTime() - startOfUtcWeek(period.from).getTime()) / (7 * DAY)) + 1;
  switch (spec.metric) {
    case 'cycle_time':
    case 'lead_time': {
      const opts = { windowDays, now: end };
      const stats = spec.metric === 'cycle_time' ? cycleTime(ds, opts) : leadTime(ds, opts);
      if (stats.count === 0) return empty('no_data');
      if (spec.chart === 'kpi') {
        return {
          kind: 'kpi',
          value: stats[`p${spec.params.percentile}`],
          format: 'days',
          hint: { key: 'finishedInSelection', values: { count: stats.count } },
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
    case 'flow_efficiency': {
      const result = flowEfficiency(ds, { windowDays, now: end });
      if (result.efficiency === null) return empty('no_data');
      return {
        kind: 'kpi',
        value: result.efficiency,
        format: 'percent',
        hint: { key: 'blockedDays', values: { days: Math.round(result.blockedDays) } },
      };
    }
    case 'throughput':
      return {
        kind: 'series',
        chart: 'bar',
        x: 'week',
        series: [{ key: 'done' }],
        rows: weeklyThroughput(ds, { weeks, now: end }).map((r) => ({ week: r.weekStart, done: r.count })),
      };
    case 'throughput_rate':
      return {
        kind: 'kpi',
        value: throughputPerWeek(ds, { days: windowDays, now: end }),
        format: 'per_week',
        hint: { key: 'selectedSprints', values: { count: sprints.length } },
      };
    case 'wip_trend':
      return {
        kind: 'series',
        chart: 'line',
        x: 'day',
        series: [{ key: 'wip' }],
        rows: wipSeries(ds, { days: calendarDays, now: end }).map((r) => ({ day: r.day, wip: r.wip })),
      };
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
        rows: cumulativeFlow(ds, { days: calendarDays, now: end }),
      };
    default:
      return computeWidget(spec, ds, now);
  }
}
```

- [ ] **Step 4: Run the dashboards tests**

Run: `npx vitest run --project dashboards && (cd packages/dashboards && npx tsc --noEmit -p tsconfig.json)`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/dashboards
git add packages/dashboards
git commit -m "feat(dashboards): time-based widgets follow the selected sprints' period"
```

---

### Task 5: Show breakdowns, sprint lines and the "not filtered" note

**Files:**
- Modify: `apps/web/src/components/dashboard/kpi-cards.tsx` (breakdown list, unfiltered note)
- Modify: `apps/web/src/components/dashboard/widget-card.tsx` (series `label`, unfiltered note)
- Modify: `apps/web/src/components/dashboard/message-keys.ts` (`DASHBOARD_HINTS` += `selectedSprints`, `finishedInSelection`)
- Modify: `apps/web/messages/en.json`, `apps/web/messages/fr.json` (`dashboards.hints.*`, `dashboards.notSprintFiltered`)
- Test: covered by `apps/web/src/lib/message-keys.test.ts` (ties `DASHBOARD_HINTS` to both message files) — run it

**Interfaces:**
- Consumes: `WidgetData.breakdown`, `series[].label`, `unfiltered` (Task 3).

- [ ] **Step 1: Add the messages** (both files, inside `"dashboards"`):

`en.json` — in `"hints"` add `"selectedSprints": "{count, plural, one {Selected sprint} other {# selected sprints}}"` and `"finishedInSelection": "{count} finished in the selected sprints"`; next to `"notEnoughData"` add `"notSprintFiltered": "Not filtered by sprint"`.

`fr.json` — `"selectedSprints": "{count, plural, one {Sprint sélectionné} other {# sprints sélectionnés}}"`, `"finishedInSelection": "{count} terminés dans les sprints sélectionnés"`, `"notSprintFiltered": "Non filtré par sprint"`.

In `message-keys.ts`, `DASHBOARD_HINTS` becomes:

```ts
export const DASHBOARD_HINTS = [
  'lastSprints',
  'scopeRemoved',
  'carriedFrom',
  'finishedIn',
  'lastDays',
  'blockedDays',
  'selectedSprints',
  'finishedInSelection',
] as const;
```

- [ ] **Step 2: Run the message tests**

Run: `npx vitest run apps/web/src/lib/message-keys.test.ts apps/web/src/messages.test.ts`
Expected: PASS (both files carry the new keys).

- [ ] **Step 3: Render the breakdown and the note in `kpi-cards.tsx`** — extract the number formatting so the breakdown reuses it, and add to the card footer:

```tsx
  const formatted = (kpiFormat: KpiFormat, v: number | null): string => {
    if (v === null) return '—';
    if (kpiFormat === 'percent') {
      return format.number(v, { style: 'percent', maximumFractionDigits: 0 });
    }
    return t(`units.${kpiFormat}`, {
      count: v,
      value: format.number(v, { maximumFractionDigits: 1 }),
    });
  };
  const value = ({ data }: RenderedWidget): string =>
    data.kind === 'kpi' ? formatted(data.format, data.value) : '—';
```

(import `type KpiFormat` from `@agile/dashboards`), and the footer becomes:

```tsx
          <CardFooter className="flex-col items-start gap-1.5 text-sm">
            <div className="text-muted-foreground">{hint(w)}</div>
            {w.data.kind === 'kpi' && w.data.breakdown && (
              <ul className="grid w-full gap-0.5 text-xs" data-breakdown>
                {w.data.breakdown.map((b) => (
                  <li key={b.label} className="flex justify-between gap-3">
                    <span className="truncate text-muted-foreground">{b.label}</span>
                    <span className="tabular-nums">
                      {formatted((w.data as Extract<typeof w.data, { kind: 'kpi' }>).format, b.value)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {w.data.unfiltered && (
              <div className="text-xs text-muted-foreground" data-unfiltered>
                {t('notSprintFiltered')}
              </div>
            )}
          </CardFooter>
```

- [ ] **Step 4: Series labels and the note in `widget-card.tsx`**

```tsx
        {data.kind === 'series' && (
          <WidgetChart
            data={data}
            labels={Object.fromEntries(
              data.series.map((s) => [s.key, s.label ?? seriesLabel(s.key)]),
            )}
          />
        )}
```

and, right after `</CardContent>`:

```tsx
      {data.unfiltered && (
        <p className="px-6 pb-4 text-xs text-muted-foreground" data-unfiltered>
          {t('notSprintFiltered')}
        </p>
      )}
```

- [ ] **Step 5: Typecheck, lint and the web tests**

Run: `(cd apps/web && npx tsc --noEmit -p tsconfig.json) && npx biome check apps/web && npx vitest run --project web`
Expected: no errors; all web tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/dashboard apps/web/messages
git commit -m "feat(web): show per-sprint breakdowns, sprint lines and unfiltered widgets"
```

---

### Task 6: The sprint picker and the board page

**Files:**
- Create: `apps/web/src/components/ui/popover.tsx` (shadcn popover on `radix-ui`)
- Create: `apps/web/src/components/dashboard/sprint-selection.ts` (pure URL helpers)
- Create: `apps/web/src/components/dashboard/sprint-picker.tsx` (client component)
- Modify: `apps/web/src/app/(app)/boards/[boardId]/page.tsx` (read `sprints`, pass the scope and the picker)
- Modify: `apps/web/messages/en.json`, `apps/web/messages/fr.json` (`dashboards.sprintFilter.*`)
- Test: `apps/web/src/components/dashboard/sprint-selection.test.ts`

**Interfaces:**
- Consumes: `parseSprintSelection`, `bySprintDate`, `MAX_SELECTED_SPRINTS`, `computeWidget(spec, ds, now, scope?)` from `@agile/dashboards`.
- Produces: `toggleSprint(selected: readonly string[], id: string, max?: number): string[]`; `sprintsHref(pathname: string, search: string, selected: readonly string[]): string`; `SprintOption { id: string; name: string; state: 'future' | 'active' | 'closed'; dates: string | null }`; `<SprintPicker options={SprintOption[]} selected={string[]} />`.

- [ ] **Step 1: Write the failing tests** — `apps/web/src/components/dashboard/sprint-selection.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sprintsHref, toggleSprint } from './sprint-selection';

describe('sprint selection URL', () => {
  it('toggles a sprint on and off, up to the limit', () => {
    expect(toggleSprint([], 'a')).toEqual(['a']);
    expect(toggleSprint(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggleSprint(['a', 'b'], 'c', 2)).toEqual(['a', 'b']);
  });

  it('writes the sprints parameter and keeps the others', () => {
    expect(sprintsHref('/boards/x', '?tab=1', ['a', 'b'])).toBe('/boards/x?tab=1&sprints=a%2Cb');
  });

  it('clearing removes the parameter', () => {
    expect(sprintsHref('/boards/x', '?sprints=a&tab=1', [])).toBe('/boards/x?tab=1');
    expect(sprintsHref('/boards/x', '?sprints=a', [])).toBe('/boards/x');
  });

  it('drops a stale error parameter', () => {
    expect(sprintsHref('/boards/x', '?error=unknown', ['a'])).toBe('/boards/x?sprints=a');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run apps/web/src/components/dashboard/sprint-selection.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the helpers** — `apps/web/src/components/dashboard/sprint-selection.ts`:

```ts
/** Sprints the dashboard can compare at once (same limit as @agile/dashboards). */
export const MAX_SPRINTS = 10;

/** Adds or removes one sprint; adding past `max` changes nothing. */
export function toggleSprint(selected: readonly string[], id: string, max = MAX_SPRINTS): string[] {
  if (selected.includes(id)) return selected.filter((s) => s !== id);
  return selected.length >= max ? [...selected] : [...selected, id];
}

/** The dashboard URL for a selection: `sprints` set (or removed when empty), others kept. */
export function sprintsHref(pathname: string, search: string, selected: readonly string[]): string {
  const params = new URLSearchParams(search);
  params.delete('error');
  if (selected.length > 0) params.set('sprints', selected.join(','));
  else params.delete('sprints');
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
```

Run: `npx vitest run apps/web/src/components/dashboard/sprint-selection.test.ts`
Expected: PASS.

- [ ] **Step 4: Add the popover** — `apps/web/src/components/ui/popover.tsx` (the shadcn component, in this repo's ui style):

```tsx
"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger(props: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "start",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-72 rounded-md border bg-popover p-0 text-popover-foreground shadow-md outline-hidden data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverContent }
```

- [ ] **Step 5: Add the picker messages** (inside `"dashboards"` in both files):

`en.json`: `"sprintFilter": { "button": "Sprints", "search": "Find a sprint…", "none": "No sprint found.", "clear": "Clear", "limit": "Up to {max} sprints", "remove": "Remove {name}", "allSprints": "All widgets show their own period", "states": { "active": "Active", "closed": "Closed", "future": "Future" } }`

`fr.json`: `"sprintFilter": { "button": "Sprints", "search": "Chercher un sprint…", "none": "Aucun sprint trouvé.", "clear": "Effacer", "limit": "Jusqu’à {max} sprints", "remove": "Retirer {name}", "allSprints": "Chaque widget affiche sa propre période", "states": { "active": "En cours", "closed": "Terminé", "future": "À venir" } }`

- [ ] **Step 6: The picker** — `apps/web/src/components/dashboard/sprint-picker.tsx`:

```tsx
'use client';

import { Check, ChevronsUpDown, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { MAX_SPRINTS, sprintsHref, toggleSprint } from './sprint-selection';

export interface SprintOption {
  id: string;
  name: string;
  state: 'future' | 'active' | 'closed';
  /** Formatted on the server ("6 Oct – 20 Oct"), null for sprints without dates. */
  dates: string | null;
}

/**
 * Picks the sprints the whole dashboard is scoped to. The choice lives in the URL (`sprints`), so
 * the page re-renders on the server and the link can be shared.
 */
export function SprintPicker({
  options,
  selected,
}: {
  /** Newest first: future sprints, then by start date descending. */
  options: SprintOption[];
  /** Chronological, as the server resolved them. */
  selected: string[];
}) {
  const t = useTranslations('dashboards.sprintFilter');
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [pending, startTransition] = useTransition();
  const byId = new Map(options.map((o) => [o.id, o]));
  const go = (next: string[]) =>
    startTransition(() => {
      router.replace(sprintsHref(pathname, search.toString(), next), { scroll: false });
    });
  const full = selected.length >= MAX_SPRINTS;

  return (
    <div className="flex flex-wrap items-center gap-2" data-sprint-picker aria-busy={pending}>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">
            {t('button')}
            {selected.length > 0 && <Badge variant="secondary">{selected.length}</Badge>}
            <ChevronsUpDown className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80">
          <Command>
            <CommandInput placeholder={t('search')} />
            <CommandList>
              <CommandEmpty>{t('none')}</CommandEmpty>
              <CommandGroup heading={full ? t('limit', { max: MAX_SPRINTS }) : undefined}>
                {options.map((o) => {
                  const on = selected.includes(o.id);
                  return (
                    <CommandItem
                      key={o.id}
                      value={`${o.name} ${o.id}`}
                      disabled={!on && full}
                      onSelect={() => go(toggleSprint(selected, o.id))}
                    >
                      <Check className={cn('size-4', on ? 'opacity-100' : 'opacity-0')} />
                      <span className="min-w-0 flex-1 truncate">{o.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {o.dates ?? t(`states.${o.state}`)}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {selected.length === 0 ? (
        <span className="text-sm text-muted-foreground">{t('allSprints')}</span>
      ) : (
        <>
          {selected.map((id) => {
            const name = byId.get(id)?.name ?? id;
            return (
              <Badge key={id} variant="secondary" className="gap-1 pr-1">
                {name}
                <button
                  type="button"
                  className="rounded-sm opacity-70 hover:opacity-100"
                  aria-label={t('remove', { name })}
                  onClick={() => go(toggleSprint(selected, id))}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            );
          })}
          <Button variant="ghost" size="sm" onClick={() => go([])}>
            {t('clear')}
          </Button>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Wire the page** — in `apps/web/src/app/(app)/boards/[boardId]/page.tsx`:

1. `searchParams: Promise<{ error?: string | string[]; sprints?: string | string[] }>` and `const { error, sprints: sprintsParam } = await searchParams;`
2. Add to the `@agile/dashboards` import: `bySprintDate`, `parseSprintSelection`; import `SprintPicker`, `type SprintOption` from `@/components/dashboard/sprint-picker`.
3. After the empty-dataset early return, before `const views`:

```tsx
  const selected = parseSprintSelection(sprintsParam, dataset.sprints);
  const scope = selected.length > 0 ? { sprints: selected } : undefined;
  const range = (s: (typeof dataset.sprints)[number]) =>
    s.startAt
      ? format.dateTimeRange(s.startAt, s.completeAt ?? s.endAt ?? now, {
          day: 'numeric',
          month: 'short',
          timeZone: 'UTC',
        })
      : null;
  // Newest first, as list_sprints: future sprints, then by start date descending.
  const sprintOptions: SprintOption[] = [...dataset.sprints]
    .sort((a, b) => -bySprintDate(a, b))
    .map((s) => ({ id: s.id, name: s.name, state: s.state, dates: range(s) }));
```

4. In `views`, compute with the scope: `widgets: d.widgets.map((spec) => ({ spec, data: computeWidget(spec, dataset, now, scope) })),`
5. Render the picker between the error alert / insights and the `<Tabs>` (only when the board has sprints):

```tsx
      {sprintOptions.length > 0 && (
        <SprintPicker options={sprintOptions} selected={selected.map((s) => s.id)} />
      )}
```

- [ ] **Step 8: Typecheck, lint, tests**

Run: `(cd apps/web && npx tsc --noEmit -p tsconfig.json) && npx biome check apps/web && npx vitest run --project web`
Expected: no errors; all web tests PASS.

- [ ] **Step 9: Browser check** (dev server on http://localhost:3000 with the demo or a synced Scrum board):
1. Open a board dashboard: the picker shows "Sprints" and "All widgets show their own period"; widgets as before.
2. Pick one closed sprint: the URL gets `?sprints=<id>`; velocity shows one bar pair, the KPIs show that sprint, the burndown is that sprint's; WIP / forecasts show "Not filtered by sprint".
3. Add a second sprint: velocity two pairs, KPI cards list both sprints, burndown two lines named after the sprints.
4. Reload: same view. Clear: URL without `sprints`, page as in step 1.
Record the result (and screenshots if available) in the task report.

- [ ] **Step 10: Commit**

```bash
npx biome check --write apps/web/src/components apps/web/src/app
git add apps/web/src/components/ui/popover.tsx apps/web/src/components/dashboard "apps/web/src/app/(app)/boards/[boardId]/page.tsx" apps/web/messages
git commit -m "feat(web): pick sprints on the board dashboard to scope or compare them"
```
