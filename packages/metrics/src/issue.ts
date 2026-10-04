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
