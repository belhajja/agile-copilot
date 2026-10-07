import {
  type BoardDataset,
  DAY,
  doneAt,
  isoDay,
  type MetricIssue,
  type MetricSprint,
} from '@agile/metrics';
import { bySprintDate } from '../sprint-scope';
import type { KpiFormat, WidgetData, WidgetNote } from '../widget-data';
import { bucketIssues, type GroupContext, MULTI_VALUED, NONE, OTHER, timeKeys } from './group';
import { measureOf } from './measure';
import {
  type BoardQuery,
  type Column,
  type Dimension,
  type Measure,
  TIME_DIMENSIONS,
} from './schema';
import { resolveSprints, selectIssues, sprintsByIssue, windowStart } from './select';

/** Most category groups shown (the rest folds into Other). */
const MAX_GROUPS = 20;
/** Most series of a second dimension (the rest folds into Other). */
const MAX_SERIES = 8;

const NEW_FIELD_FILTERS = ['labels', 'epics', 'priorities', 'components', 'fixVersions'] as const;
const NEW_FIELD_DIMENSIONS: ReadonlySet<Dimension> = new Set<Dimension>([
  'label',
  'epic',
  'priority',
  'component',
  'fixVersion',
]);
const NEW_FIELD_COLUMNS: ReadonlySet<Column> = new Set<Column>(['priority', 'epic', 'labels']);

const COLUMN_TYPES: Record<Column, 'text' | 'number' | 'days' | 'date'> = {
  key: 'text',
  summary: 'text',
  type: 'text',
  status: 'text',
  assignee: 'text',
  points: 'number',
  priority: 'text',
  epic: 'text',
  labels: 'text',
  created: 'date',
  resolved: 'date',
  age: 'days',
};

interface Group {
  label: string;
  issues: MetricIssue[];
}

interface Ctx extends GroupContext {
  ds: BoardDataset;
  query: BoardQuery;
  measure: Measure;
  now: Date;
  notes: WidgetNote[];
}

const formatOf = (m: Measure): KpiFormat =>
  m === 'count' ? 'issues' : m === 'points' ? 'points' : 'days';
const valueType = (m: Measure): 'number' | 'days' =>
  m === 'count' || m === 'points' ? 'number' : 'days';

function usesNewFields(q: BoardQuery): boolean {
  return (
    NEW_FIELD_FILTERS.some((k) => q.filter?.[k] !== undefined) ||
    (q.groupBy ?? []).some((d) => NEW_FIELD_DIMENSIONS.has(d)) ||
    (q.list?.columns ?? []).some((c) => NEW_FIELD_COLUMNS.has(c))
  );
}

/** The groups' issues, each once (multi-valued groups share issues). */
const unique = (groups: readonly Group[]): MetricIssue[] => [
  ...new Map(groups.flatMap((g) => g.issues.map((i) => [i.id, i] as const))).values(),
];

const byLabel = (a: Group, b: Group) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);

/** Groups of one dimension, ordered and capped. */
function groupsFor(
  issues: readonly MetricIssue[],
  dim: Dimension,
  ctx: Ctx,
  limits: { max: number; top?: number },
): Group[] {
  const buckets = bucketIssues(issues, dim, ctx);
  if (TIME_DIMENSIONS.has(dim)) {
    const created = dim.startsWith('created');
    const window = created ? ctx.query.filter?.created : ctx.query.filter?.resolved;
    const dates = issues.flatMap((i) => {
      const at = created ? i.createdAt : doneAt(i);
      return at ? [at.getTime()] : [];
    });
    if (!window && dates.length === 0) return [];
    const from = window ? windowStart(ctx.ds, window, ctx.now) : new Date(Math.min(...dates));
    const to = window ? ctx.now : new Date(Math.max(...dates));
    return timeKeys(dim, from, to).map((label) => ({ label, issues: buckets.get(label) ?? [] }));
  }
  const groups = [...buckets].map(([label, list]) => ({ label, issues: list }));
  if (dim === 'sprint') {
    const order = [...ctx.ds.sprints].sort(bySprintDate).map((s) => s.name);
    const rank = (g: Group) =>
      g.label === NONE ? Number.POSITIVE_INFINITY : order.indexOf(g.label);
    const named = groups.filter((g) => g.label !== NONE).sort((a, b) => rank(a) - rank(b));
    const none = groups.filter((g) => g.label === NONE);
    if (named.length <= MAX_GROUPS) return [...named, ...none];
    ctx.notes.push({ key: 'capped', values: { shown: MAX_GROUPS, total: named.length } });
    return [...named.slice(-MAX_GROUPS), ...none];
  }
  const value = new Map(groups.map((g) => [g, measureOf(g.issues, ctx.measure, ctx.now)]));
  const sorted = groups.sort((a, b) => {
    const va = value.get(a) ?? null;
    const vb = value.get(b) ?? null;
    if (va === vb) return byLabel(a, b);
    if (va === null) return 1;
    if (vb === null) return -1;
    return vb - va;
  });
  const keep = limits.top ?? limits.max;
  if (sorted.length <= keep) return sorted;
  if (limits.top === undefined) {
    ctx.notes.push({ key: 'capped', values: { shown: keep, total: sorted.length } });
  }
  return [...sorted.slice(0, keep), { label: OTHER, issues: unique(sorted.slice(keep)) }];
}

function cellOf(i: MetricIssue, column: Column, now: Date): string | number | null {
  switch (column) {
    case 'key':
      return i.key;
    case 'summary':
      return i.summary;
    case 'type':
      return i.type;
    case 'status':
      return i.status || null;
    case 'assignee':
      return i.assignee;
    case 'points':
      return i.estimate;
    case 'priority':
      return i.priority ?? null;
    case 'epic':
      return i.epicName ?? i.epicKey ?? null;
    case 'labels':
      return i.labels && i.labels.length > 0 ? i.labels.join(', ') : null;
    case 'created':
      return isoDay(i.createdAt);
    case 'resolved': {
      const at = doneAt(i);
      return at ? isoDay(at) : null;
    }
    case 'age':
      return doneAt(i)
        ? null
        : Math.round(((now.getTime() - i.createdAt.getTime()) / DAY) * 10) / 10;
  }
}

/** Empty values last, whatever the direction; numbers numerically; text with numeric parts. */
function compareCells(a: string | number | null, b: string | number | null, dir: 1 | -1): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return dir * (a - b);
  return dir * String(a).localeCompare(String(b), 'en', { numeric: true });
}

function listOf(issues: readonly MetricIssue[], query: BoardQuery, ctx: Ctx): WidgetData {
  const list = query.list;
  if (!list) return { kind: 'empty', reason: 'no_match' };
  const by = list.sort?.by ?? 'key';
  const dir = list.sort?.dir === 'desc' ? -1 : 1;
  const sorted = [...issues].sort((a, b) =>
    compareCells(cellOf(a, by, ctx.now), cellOf(b, by, ctx.now), dir),
  );
  if (sorted.length > list.limit) {
    ctx.notes.push({ key: 'capped', values: { shown: list.limit, total: sorted.length } });
  }
  return {
    kind: 'table',
    columns: list.columns.map((c) => ({ key: c, type: COLUMN_TYPES[c] })),
    rows: sorted.slice(0, list.limit).map((i) => list.columns.map((c) => cellOf(i, c, ctx.now))),
  };
}

/**
 * Runs a board query on synced data. Pure and deterministic for a given `now`. Without its own
 * `sprints` filter the query follows the dashboard's sprint selection (`scope`); with one it is
 * computed as is and flagged `unfiltered` when a selection is active.
 */
export function runQuery(
  ds: BoardDataset,
  query: BoardQuery,
  opts: { now: Date; scope?: readonly MetricSprint[] },
): WidgetData {
  const { now } = opts;
  const sprintsOf = sprintsByIssue(ds);
  const ownSprints = query.filter?.sprints !== undefined;
  const scoped = (opts.scope?.length ?? 0) > 0;
  const issues = selectIssues(ds, query, {
    now,
    scope: ownSprints ? undefined : opts.scope,
    sprintsOf,
  });
  const notes: WidgetNote[] = [];
  const measure: Measure = query.measure === 'points' && !ds.hasEstimates ? 'count' : query.measure;
  if (measure !== query.measure) notes.push({ key: 'pointsAsCount' });
  if (ds.fieldsSynced === false && usesNewFields(query)) notes.push({ key: 'fieldsSyncing' });
  const dims = query.groupBy ?? [];
  if (dims.some((d) => MULTI_VALUED.has(d))) notes.push({ key: 'multiValued' });
  const finish = (data: WidgetData): WidgetData => ({
    ...data,
    ...(notes.length > 0 ? { notes } : {}),
    ...(ownSprints && scoped ? { unfiltered: true as const } : {}),
  });

  if (query.display === 'kpi') {
    return finish({
      kind: 'kpi',
      value: measureOf(issues, measure, now),
      format: formatOf(measure),
    });
  }
  const sprintLimit = ownSprints
    ? resolveSprints(ds, query.filter?.sprints ?? [])
    : scoped
      ? opts.scope
      : undefined;
  const ctx: Ctx = {
    ds,
    query,
    measure,
    now,
    notes,
    sprintsOf,
    allowedSprints: sprintLimit ? new Set(sprintLimit.map((s) => s.id)) : null,
  };
  if (issues.length === 0) return finish({ kind: 'empty', reason: 'no_match' });
  if (query.display === 'list') return finish(listOf(issues, query, ctx));

  const [first, second] = dims;
  if (!first) return finish({ kind: 'empty', reason: 'no_match' });
  const rows = groupsFor(issues, first, ctx, { max: MAX_GROUPS, top: query.top });
  if (rows.length === 0) return finish({ kind: 'empty', reason: 'no_match' });

  if (!second) {
    const values = rows.map((g) => measureOf(g.issues, measure, now));
    if (query.display === 'table') {
      return finish({
        kind: 'table',
        columns: [
          { key: first, type: 'text' },
          { key: measure, type: valueType(measure) },
        ],
        rows: rows.map((g, i) => [g.label, values[i] ?? null]),
      });
    }
    return finish({
      kind: 'series',
      chart: query.display === 'pie' ? 'pie' : query.display === 'line' ? 'line' : 'bar',
      x: first,
      series: [{ key: measure }],
      rows: rows.map((g, i) => ({ [first]: g.label, [measure]: values[i] ?? null })),
    });
  }

  const columns = groupsFor(issues, second, ctx, { max: MAX_SERIES });
  const cell = (row: Group, column: Group) => {
    const ids = new Set(column.issues.map((i) => i.id));
    return measureOf(
      row.issues.filter((i) => ids.has(i.id)),
      measure,
      now,
    );
  };
  if (query.display === 'table') {
    return finish({
      kind: 'table',
      columns: [
        { key: first, type: 'text' },
        ...columns.map((c, i) => ({ key: `s${i}`, type: valueType(measure), label: c.label })),
      ],
      rows: rows.map((r) => [r.label, ...columns.map((c) => cell(r, c))]),
    });
  }
  return finish({
    kind: 'series',
    chart: 'bar',
    x: first,
    series: columns.map((c, i) => ({ key: `s${i}`, label: c.label, stacked: true })),
    rows: rows.map((r) => ({
      [first]: r.label,
      ...Object.fromEntries(columns.map((c, i) => [`s${i}`, cell(r, c)])),
    })),
  });
}
