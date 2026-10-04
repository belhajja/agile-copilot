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
