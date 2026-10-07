import {
  type BoardDataset,
  currentCategory,
  DAY,
  doneAt,
  type MetricIssue,
  type MetricSprint,
} from '@agile/metrics';
import { bySprintDate } from '../sprint-scope';
import type { BoardQuery, QueryFilter, QueryWindow, SprintRef } from './schema';

const lower = (s: string) => s.trim().toLowerCase();

/** Every sprint each issue was ever in, chronological and distinct. */
export function sprintsByIssue(ds: BoardDataset): Map<string, MetricSprint[]> {
  const map = new Map<string, MetricSprint[]>();
  for (const sprint of [...ds.sprints].sort(bySprintDate)) {
    for (const m of sprint.members) {
      const list = map.get(m.issueId) ?? [];
      if (!list.includes(sprint)) list.push(sprint);
      map.set(m.issueId, list);
    }
  }
  return map;
}

/** Closed sprints, the most recently completed first. */
function closedSprints(ds: BoardDataset): (MetricSprint & { completeAt: Date })[] {
  return ds.sprints
    .filter((s): s is MetricSprint & { completeAt: Date } => s.state === 'closed' && s.completeAt !== null)
    .sort((a, b) => b.completeAt.getTime() - a.completeAt.getTime());
}

/** The board's sprints a query names. Unknown ids resolve to nothing. */
export function resolveSprints(ds: BoardDataset, refs: readonly SprintRef[]): MetricSprint[] {
  const closed = closedSprints(ds);
  const found = new Map<string, MetricSprint>();
  for (const ref of refs) {
    const picked =
      ref === 'active'
        ? ds.sprints.filter((s) => s.state === 'active')
        : ref === 'last_closed'
          ? closed.slice(0, 1)
          : 'lastClosed' in ref
            ? closed.slice(0, ref.lastClosed)
            : ds.sprints.filter((s) => s.id === ref.id);
    for (const s of picked) found.set(s.id, s);
  }
  return [...found.values()];
}

/**
 * Where a relative window starts: `lastDays` back from now, or the start of the n-th most recently
 * started sprint (the oldest one when there are fewer; now, so an empty window, when none).
 */
export function windowStart(ds: BoardDataset, w: QueryWindow, now: Date): Date {
  if ('lastDays' in w) return new Date(now.getTime() - w.lastDays * DAY);
  const started = ds.sprints
    .filter((s): s is MetricSprint & { startAt: Date } => s.startAt !== null && s.startAt.getTime() <= now.getTime())
    .sort((a, b) => b.startAt.getTime() - a.startAt.getTime());
  return (started[w.sinceSprintsAgo - 1] ?? started.at(-1))?.startAt ?? now;
}

const within = (at: Date | null, from: Date, now: Date) =>
  at !== null && at.getTime() > from.getTime() && at.getTime() <= now.getTime();

/**
 * The issues a query's filter keeps. Filters combine with AND, values in one filter with OR; names
 * match case-insensitively. Without its own `sprints`, the query follows the dashboard's sprint
 * selection (`scope`): issues that were in one of those sprints.
 */
export function selectIssues(
  ds: BoardDataset,
  query: BoardQuery,
  opts: {
    now: Date;
    scope?: readonly MetricSprint[];
    sprintsOf: Map<string, MetricSprint[]>;
  },
): MetricIssue[] {
  const { now } = opts;
  const f: QueryFilter = query.filter ?? {};
  const set = (values: readonly string[] | undefined) => (values ? new Set(values.map(lower)) : null);
  const types = set(f.types);
  const statuses = set(f.statuses);
  const labels = set(f.labels);
  const epics = set(f.epics);
  const priorities = set(f.priorities);
  const components = set(f.components);
  const fixVersions = set(f.fixVersions);
  const categories = f.statusCategory ? new Set<string>(f.statusCategory) : null;
  const assignees = f.assignees
    ? new Set(f.assignees.map((a) => (a === null ? null : lower(a))))
    : null;
  const sprints = f.sprints
    ? resolveSprints(ds, f.sprints)
    : opts.scope && opts.scope.length > 0
      ? opts.scope
      : null;
  const sprintIds = sprints ? new Set(sprints.map((s) => s.id)) : null;
  const created = f.created ? windowStart(ds, f.created, now) : null;
  const resolved = f.resolved ? windowStart(ds, f.resolved, now) : null;

  const has = (wanted: Set<string> | null, value: string | null | undefined) =>
    !wanted || (value != null && wanted.has(lower(value)));
  const hasAny = (wanted: Set<string> | null, values: readonly string[] | undefined) =>
    !wanted || (values ?? []).some((v) => wanted.has(lower(v)));

  return ds.issues.filter(
    (i) =>
      has(types, i.type) &&
      has(statuses, i.status) &&
      (!categories || categories.has(currentCategory(i))) &&
      (!assignees || assignees.has(i.assignee === null ? null : lower(i.assignee))) &&
      hasAny(labels, i.labels) &&
      hasAny(components, i.components) &&
      hasAny(fixVersions, i.fixVersions) &&
      has(priorities, i.priority) &&
      (!epics || has(epics, i.epicKey) || has(epics, i.epicName)) &&
      (!sprintIds || (opts.sprintsOf.get(i.id) ?? []).some((s) => sprintIds.has(s.id))) &&
      (!created || within(i.createdAt, created, now)) &&
      (!resolved || within(doneAt(i), resolved, now)),
  );
}
