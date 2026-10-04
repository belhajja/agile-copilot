import { blockedStatusIntervals, categoryAt, currentCategory, cycleStart, doneAt } from './issue';
import type { BoardDataset, MetricIssue } from './model';
import { coveredMs, percentile, round, total } from './stats';
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
export function throughputPerWeek(
  ds: BoardDataset,
  opts: { days?: number; now: Date },
): number | null {
  const days = opts.days ?? 28;
  if (!(days > 0)) return null;
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
    .sort(
      (a, b) => b.ageDays - a.ageDays || a.key.localeCompare(b.key, undefined, { numeric: true }),
    );
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
  const cycleDays = total(items.map((c) => c.cycleDays ?? 0));
  const blockedDays = total(items.map((c) => c.blockedDays));
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
