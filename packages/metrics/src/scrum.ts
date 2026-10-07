import {
  CLOSE_TOLERANCE_MS,
  categoryAt,
  indexIssues,
  membersAt,
  membersAtClose,
  valueAt,
} from './issue';
import type { BoardDataset, MetricIssue, MetricSprint, Unit } from './model';
import { round, sum, total } from './stats';
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

/**
 * Issues in the sprint at its start, excluding ones already done then (Jira's "completed outside
 * this sprint"). An issue done at start, reopened and re-done inside the sprint stays excluded on
 * purpose; velocity and the burn charts apply the same rule.
 */
function committedIssues(
  sprint: MetricSprint & { startAt: Date },
  byId: Map<string, MetricIssue>,
): MetricIssue[] {
  return pick(membersAt(sprint, sprint.startAt), byId).filter(
    (i) => categoryAt(i, sprint.startAt) !== 'done',
  );
}

const closeMembers = (s: MetricSprint & { completeAt: Date }, byId: Map<string, MetricIssue>) =>
  pick(membersAtClose(s), byId);

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
  if (!sprint.startAt || (sprint.state === 'closed' && !sprint.completeAt)) return null;
  const unit = opts.unit ?? 'points';
  const start = sprint.startAt;
  const end = sprint.completeAt ?? opts.now;
  // Removals stamped just before close are Jira's close-time cleanup, not scope removed.
  const removedEnd = sprint.completeAt ? new Date(ms(end) - CLOSE_TOLERANCE_MS) : end;
  const byId = indexIssues(ds.issues);
  const within = (d: Date) => ms(d) > ms(start) && ms(d) < ms(end);
  const removedWithin = (d: Date) => ms(d) > ms(start) && ms(d) < ms(removedEnd);
  const added = new Map<string, number>();
  const removed = new Map<string, number>();
  for (const m of sprint.members) {
    const issue = byId.get(m.issueId);
    if (!issue) continue;
    if (within(m.addedAt) && !added.has(issue.id))
      added.set(issue.id, valueAt(issue, m.addedAt, unit));
    if (m.removedAt && removedWithin(m.removedAt) && !removed.has(issue.id)) {
      removed.set(issue.id, valueAt(issue, m.removedAt, unit));
    }
  }
  const committed = committedIssues({ ...sprint, startAt: start }, byId);
  return {
    sprintId: sprint.id,
    name: sprint.name,
    committed: total(committed.map((i) => valueAt(i, start, unit))),
    added: total([...added.values()]),
    removed: total([...removed.values()]),
    addedCount: added.size,
    removedCount: removed.size,
  };
}

/** Issues still in a closed sprint at its close that were not done. */
export function carryOver(ds: BoardDataset, sprint: MetricSprint): CarryOver | null {
  if (sprint.state !== 'closed' || !sprint.completeAt) return null;
  const at = sprint.completeAt;
  const left = closeMembers({ ...sprint, completeAt: at }, indexIssues(ds.issues)).filter(
    (i) => categoryAt(i, at) !== 'done',
  );
  return {
    sprintId: sprint.id,
    name: sprint.name,
    count: left.length,
    points: total(left.map((i) => valueAt(i, at, 'points'))),
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
): BurnRow[] | null {
  if (!sprint.startAt || (sprint.state === 'closed' && !sprint.completeAt)) return null;
  const unit = opts.unit ?? 'points';
  const byId = indexIssues(ds.issues);
  const cap = sprint.completeAt ?? opts.now;
  const plannedEnd = sprint.endAt ?? cap;
  const lastDay = new Date(Math.max(ms(plannedEnd), ms(sprint.completeAt ?? cap)));
  const days = eachUtcDay(sprint.startAt, lastDay);
  const start = sprint.startAt;
  const committed = total(
    committedIssues({ ...sprint, startAt: start }, byId).map((i) => valueAt(i, start, unit)),
  );
  const plannedDays = Math.max(1, eachUtcDay(sprint.startAt, plannedEnd).length - 1);
  return days.map((day, index) => {
    const ideal = round(Math.max(0, committed * (1 - index / plannedDays)), 2);
    if (ms(day) > ms(cap)) {
      return { day: isoDay(day), remaining: null, ideal, scope: null, completed: null };
    }
    const at = endOfDayCapped(day, cap);
    const members = (
      sprint.completeAt && ms(at) >= ms(sprint.completeAt)
        ? closeMembers({ ...sprint, completeAt: sprint.completeAt }, byId)
        : pick(membersAt(sprint, at), byId)
    ).filter((i) => categoryAt(i, start) !== 'done');
    const done = members.filter((i) => categoryAt(i, at) === 'done');
    const scope = total(members.map((i) => valueAt(i, at, unit)));
    const completed = total(done.map((i) => valueAt(i, at, unit)));
    return { day: isoDay(day), remaining: round(scope - completed, 2), ideal, scope, completed };
  });
}
