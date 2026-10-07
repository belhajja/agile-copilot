import {
  addDays,
  currentCategory,
  doneAt,
  isoDay,
  type MetricIssue,
  type MetricSprint,
  startOfUtcWeek,
} from '@agile/metrics';
import type { Dimension } from './schema';

/** Group tokens (message keys under dashboards.query.groups). */
export const NONE = '@none';
export const OTHER = '@other';

/** Dimensions where an issue can fall in several groups. */
export const MULTI_VALUED: ReadonlySet<Dimension> = new Set<Dimension>([
  'label',
  'component',
  'fixVersion',
  'sprint',
]);

export interface GroupContext {
  sprintsOf: Map<string, MetricSprint[]>;
  /** With a sprint filter or selection, sprint groups are limited to those sprints. */
  allowedSprints: ReadonlySet<string> | null;
}

const month = (d: Date) => d.toISOString().slice(0, 7);
const valuesOrNone = (values: readonly string[] | undefined) =>
  values && values.length > 0 ? [...new Set(values)] : [NONE];

/** The groups an issue falls in. [] leaves it out (a time dimension without its date). */
export function groupsOf(issue: MetricIssue, dim: Dimension, ctx: GroupContext): string[] {
  switch (dim) {
    case 'type':
      return [issue.type];
    case 'status':
      return [issue.status ? issue.status : NONE];
    case 'statusCategory':
      return [`@${currentCategory(issue)}`];
    case 'assignee':
      return [issue.assignee ?? NONE];
    case 'priority':
      return [issue.priority ?? NONE];
    case 'epic':
      return [
        issue.epicKey
          ? issue.epicName
            ? `${issue.epicKey} · ${issue.epicName}`
            : issue.epicKey
          : NONE,
      ];
    case 'label':
      return valuesOrNone(issue.labels);
    case 'component':
      return valuesOrNone(issue.components);
    case 'fixVersion':
      return valuesOrNone(issue.fixVersions);
    case 'sprint':
      return valuesOrNone(
        (ctx.sprintsOf.get(issue.id) ?? [])
          .filter((s) => !ctx.allowedSprints || ctx.allowedSprints.has(s.id))
          .map((s) => s.name),
      );
    case 'createdWeek':
      return [isoDay(startOfUtcWeek(issue.createdAt))];
    case 'createdMonth':
      return [month(issue.createdAt)];
    case 'resolvedWeek': {
      const at = doneAt(issue);
      return at ? [isoDay(startOfUtcWeek(at))] : [];
    }
    case 'resolvedMonth': {
      const at = doneAt(issue);
      return at ? [month(at)] : [];
    }
  }
}

/** Issues per group, groups in first-seen order. */
export function bucketIssues(
  issues: readonly MetricIssue[],
  dim: Dimension,
  ctx: GroupContext,
): Map<string, MetricIssue[]> {
  const buckets = new Map<string, MetricIssue[]>();
  for (const issue of issues) {
    for (const key of groupsOf(issue, dim, ctx)) {
      const list = buckets.get(key);
      if (list) list.push(issue);
      else buckets.set(key, [issue]);
    }
  }
  return buckets;
}

/** Every week (yyyy-mm-dd, Monday) or month (yyyy-mm) key from `from` to `to`, inclusive. */
export function timeKeys(dim: Dimension, from: Date, to: Date): string[] {
  const keys: string[] = [];
  if (dim.endsWith('Week')) {
    const last = startOfUtcWeek(to).getTime();
    for (let w = startOfUtcWeek(from); w.getTime() <= last; w = addDays(w, 7)) keys.push(isoDay(w));
    return keys;
  }
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth();
  const end = to.getUTCFullYear() * 12 + to.getUTCMonth();
  while (y * 12 + m <= end) {
    keys.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    m += 1;
    if (m === 12) {
      m = 0;
      y += 1;
    }
  }
  return keys;
}
