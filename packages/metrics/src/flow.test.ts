import { describe, expect, it } from 'vitest';
import { d, flowFixture, issue } from './fixtures';
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

describe('flow metrics: real-Jira edge cases', () => {
  const now = d(30);
  const ds = (issues: ReturnType<typeof issue>[]) => ({ issues, sprints: [], hasEstimates: true });

  it('uses the final done of an issue reopened after done', () => {
    // created d0, in progress d1, done d3, reopened d5 (in progress), done d9
    const reopened = issue('R1', {
      created: d(0),
      steps: [
        [d(1), 'in_progress'],
        [d(3), 'done'],
        [d(5), 'in_progress'],
        [d(9), 'done'],
      ],
    });
    expect(completedItems(ds([reopened]), { now }).map((c) => [c.cycleDays, c.leadDays])).toEqual([
      [8, 9],
    ]);
    // Reopened and not done again: not a completed item, counted as work in progress.
    const open = issue('R2', {
      created: d(0),
      steps: [
        [d(1), 'in_progress'],
        [d(3), 'done'],
        [d(5), 'in_progress'],
      ],
    });
    expect(completedItems(ds([open]), { now })).toEqual([]);
    expect(wipNow(ds([open]))).toBe(1);
    expect(weeklyThroughput(ds([reopened]), { now: d(10), weeks: 2 })).toEqual([
      { weekStart: '2026-01-05', count: 0 },
      { weekStart: '2026-01-12', count: 1 },
    ]);
  });

  it('gives never-started issues a lead time but no cycle time or age', () => {
    const idle = ds([
      issue('N1', { created: d(0), steps: [[d(4), 'done']] }),
      issue('N2', { created: d(29) }),
    ]);
    expect(cycleTime(idle, { now })).toEqual({ count: 0, p50: null, p85: null, p95: null });
    expect(leadTime(idle, { now })).toEqual({ count: 1, p50: 4, p85: 4, p95: 4 });
    expect(agingWip(idle, { now })).toEqual([]);
    expect(flowEfficiency(idle, { now })).toEqual({
      efficiency: null,
      cycleDays: 0,
      blockedDays: 0,
    });
  });

  it('holds work in progress steady on days without transitions', () => {
    // in progress d2 12:00 → done d6 12:00; nothing happens d3, d4, d5
    // days d1..d8 end-of-day: d1 0, d2-d5 1, d6 (done at 12:00) 0, d7, d8 0
    const one = ds([
      issue('W1', {
        created: d(0),
        steps: [
          [d(2, 12), 'in_progress'],
          [d(6, 12), 'done'],
        ],
      }),
    ]);
    expect(wipSeries(one, { now: d(8), days: 8 }).map((r) => r.wip)).toEqual([
      0, 1, 1, 1, 1, 0, 0, 0,
    ]);
    expect(cumulativeFlow(one, { now: d(4, 6), days: 2 })).toEqual([
      { day: '2026-01-08', todo: 0, inProgress: 1, done: 0 },
      { day: '2026-01-09', todo: 0, inProgress: 1, done: 0 },
    ]);
  });

  it('handles an empty dataset', () => {
    const empty = ds([]);
    const none = { count: 0, p50: null, p85: null, p95: null };
    expect(completedItems(empty, { now })).toEqual([]);
    expect(cycleTime(empty, { now })).toEqual(none);
    expect(leadTime(empty, { now })).toEqual(none);
    expect(throughputPerWeek(empty, { now })).toBe(0);
    expect(weeklyThroughput(empty, { now, weeks: 2 }).map((w) => w.count)).toEqual([0, 0]);
    expect(wipNow(empty)).toBe(0);
    expect(wipSeries(empty, { now, days: 2 }).map((r) => r.wip)).toEqual([0, 0]);
    expect(cumulativeFlow(empty, { now, days: 1 })).toEqual([
      { day: '2026-02-04', todo: 0, inProgress: 0, done: 0 },
    ]);
    expect(agingWip(empty, { now })).toEqual([]);
    expect(flowEfficiency(empty, { now }).efficiency).toBeNull();
  });
});
