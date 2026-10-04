import { describe, expect, it } from 'vitest';
import { d, issue, scrumFixture } from './fixtures';
import type { MetricSprint } from './model';
import {
  carryOver,
  currentSprint,
  scopeChange,
  sprintBurn,
  velocity,
  velocitySummary,
} from './scrum';
import { addDays } from './time';

describe('scrum metrics (golden: scrumFixture)', () => {
  const ds = scrumFixture();
  const sprint = ds.sprints[0];
  if (!sprint) throw new Error('fixture');

  it('velocity: committed at start vs completed at close', () => {
    // committed = A5 + B2 (estimate at start) + C8 + D2 = 17
    // completed = done at close among A, B, C, E (D left): A5 + B3 (estimate at close) + E1 = 9
    expect(velocity(ds)).toEqual([
      {
        sprintId: 's1',
        name: 'Sprint 1',
        committed: 17,
        completed: 9,
        committedCount: 4,
        completedCount: 3,
      },
    ]);
    expect(velocity(ds, { unit: 'issues' })[0]).toMatchObject({ committed: 4, completed: 3 });
    expect(velocitySummary(velocity(ds))).toEqual({ average: 9, sayDoRatio: 0.5294 });
  });

  it('ignores sprints that are not closed', () => {
    const active = { ...sprint, id: 's2', state: 'active' as const, completeAt: null };
    expect(velocity({ ...ds, sprints: [active] })).toEqual([]);
    expect(velocitySummary([])).toEqual({ average: null, sayDoRatio: null });
  });

  it('scope change: E added (1 pt), D removed (2 pts)', () => {
    expect(scopeChange(ds, sprint, { now: d(20) })).toEqual({
      sprintId: 's1',
      name: 'Sprint 1',
      committed: 17,
      added: 1,
      removed: 2,
      addedCount: 1,
      removedCount: 1,
    });
  });

  it('carry-over: C was still open at close', () => {
    expect(carryOver(ds, sprint)).toEqual({
      sprintId: 's1',
      name: 'Sprint 1',
      count: 1,
      points: 8,
      issueKeys: ['C'],
    });
  });

  it('burndown and burnup, sampled at the end of each day', () => {
    const rows = sprintBurn(ds, sprint, { now: d(20) });
    if (!rows) throw new Error('rows');
    // day: remaining (scope - completed); ideal = 17 × (1 - i/10)
    expect(rows.map((r) => [r.day, r.remaining, r.ideal, r.scope, r.completed])).toEqual([
      ['2026-01-05', 17, 17, 17, 0],
      ['2026-01-06', 17, 15.3, 17, 0],
      ['2026-01-07', 17, 13.6, 17, 0], // A is done at d3 00:00, after this day ends
      ['2026-01-08', 12, 11.9, 17, 5],
      ['2026-01-09', 13, 10.2, 18, 5], // E added (1)
      ['2026-01-10', 12, 8.5, 17, 5], // D removed (-2), B re-estimated 2 → 3 (+1)
      ['2026-01-11', 11, 6.8, 17, 6], // E done
      ['2026-01-12', 11, 5.1, 17, 6],
      ['2026-01-13', 8, 3.4, 17, 9], // B done
      ['2026-01-14', 8, 1.7, 17, 9],
      ['2026-01-15', 8, 0, 17, 9], // sampled at the close, 09:00
    ]);
  });

  it('leaves future days of an active sprint empty', () => {
    const active = { ...sprint, state: 'active' as const, completeAt: null };
    const rows = sprintBurn({ ...ds, sprints: [active] }, active, { now: d(3, 12) });
    if (!rows) throw new Error('rows');
    expect(rows.slice(2, 5).map((r) => r.remaining)).toEqual([17, 12, null]);
    expect(currentSprint({ ...ds, sprints: [active] })?.id).toBe('s1');
  });
});

describe('scrum metrics: review fixes', () => {
  const base = scrumFixture();
  const sprint = base.sprints[0];
  if (!sprint) throw new Error('fixture');
  const mk = (
    issues: ReturnType<typeof issue>[],
    members: MetricSprint['members'],
    state: MetricSprint['state'] = 'closed',
  ) => {
    const s: MetricSprint = { ...sprint, state, members };
    return { ds: { issues, sprints: [s], hasEstimates: true }, s };
  };
  const m = (id: string, addedAt: Date, removedAt: Date | null = null) => ({
    issueId: id,
    addedAt,
    removedAt,
  });

  it('burn of an overdue active sprint runs through the day of now', () => {
    const active = { ...sprint, state: 'active' as const, completeAt: null };
    const rows = sprintBurn({ ...base, sprints: [active] }, active, { now: d(13, 12) });
    if (!rows) throw new Error('rows');
    // d0..d13 = 14 days (2026-01-05 .. 2026-01-18); ideal is 0 after the planned end.
    expect(rows).toHaveLength(14);
    expect(rows.at(-1)).toEqual({
      day: '2026-01-18',
      remaining: 8,
      ideal: 0,
      scope: 17,
      completed: 9,
    });
  });

  it('treats a removal stamped within 60 s before close as happening at close', () => {
    const members = sprint.members.map((x) =>
      x.issueId === 'C' ? { ...x, removedAt: new Date(d(10, 9).getTime() - 500) } : x,
    );
    const s = { ...sprint, members };
    const ds = { ...base, sprints: [s] };
    expect(carryOver(ds, s)).toMatchObject({ count: 1, points: 8, issueKeys: ['C'] });
    expect(scopeChange(ds, s, { now: d(20) })).toMatchObject({ removed: 2, removedCount: 1 });
    expect(velocity(ds)[0]).toMatchObject({ committed: 17, completed: 9 });
    expect(sprintBurn(ds, s, { now: d(20) })?.at(-1)).toMatchObject({ remaining: 8, scope: 17 });
  });

  it('clamps the sprint count to an integer >= 1', () => {
    const shift = (x: MetricSprint, id: string, days: number): MetricSprint => ({
      ...x,
      id,
      startAt: x.startAt && addDays(x.startAt, days),
      endAt: x.endAt && addDays(x.endAt, days),
      completeAt: x.completeAt && addDays(x.completeAt, days),
    });
    const ds = {
      ...base,
      sprints: [sprint, shift(sprint, 's2', 20), shift(sprint, 's3', 40)],
    };
    expect(velocity(ds, { sprints: 0 }).map((r) => r.sprintId)).toEqual(['s3']);
    expect(velocity(ds, { sprints: -3 }).map((r) => r.sprintId)).toEqual(['s3']);
    expect(velocity(ds, { sprints: Number.NaN })).toHaveLength(3);
    expect(velocity(ds, { sprints: 2.9 }).map((r) => r.sprintId)).toEqual(['s2', 's3']);
  });

  it('rounds point sums to 2 decimals', () => {
    const open = (k: string, est: number) =>
      issue(k, { created: d(-3), estimate: est, steps: [[d(3), 'done']] });
    const { ds, s } = mk([open('P', 0.1), open('Q', 0.2)], [m('P', d(-1)), m('Q', d(-1))]);
    // 0.1 + 0.2 = 0.30000000000000004 in floating point
    expect(velocity(ds)[0]).toMatchObject({ committed: 0.3, completed: 0.3 });
    expect(scopeChange(ds, s, { now: d(20) })?.committed).toBe(0.3);
    expect(sprintBurn(ds, s, { now: d(20) })?.at(-1)).toMatchObject({ scope: 0.3, completed: 0.3 });
  });

  it('excludes issues already done at sprint start from committed and completed', () => {
    const x = issue('X', { created: d(-3), estimate: 3, steps: [[d(-2), 'done']] });
    const y = issue('Y', { created: d(-3), estimate: 2, steps: [[d(3), 'done']] });
    const { ds, s } = mk([x, y], [m('X', d(-1)), m('Y', d(-1))]);
    // only Y counts: committed 2, completed 2
    expect(velocity(ds)[0]).toMatchObject({
      committed: 2,
      completed: 2,
      committedCount: 1,
      completedCount: 1,
    });
    expect(scopeChange(ds, s, { now: d(20) })?.committed).toBe(2);
    // burn ignores X too: day 0 scope 2 / completed 0 / remaining 2 / ideal 2; close row matches velocity
    const rows = sprintBurn(ds, s, { now: d(20) });
    expect(rows?.[0]).toEqual({
      day: '2026-01-05',
      remaining: 2,
      ideal: 2,
      scope: 2,
      completed: 0,
    });
    expect(rows?.at(-1)).toMatchObject({ scope: 2, completed: 2, remaining: 0 });
  });

  it('returns null for a closed sprint without completeAt', () => {
    const s = { ...sprint, completeAt: null };
    const ds = { ...base, sprints: [s] };
    expect(scopeChange(ds, s, { now: d(20) })).toBeNull();
    expect(sprintBurn(ds, s, { now: d(20) })).toBeNull();
  });

  it('edge: added then removed mid-sprint counts as added and removed, nothing else', () => {
    const p = issue('P', { created: d(-3), estimate: 4 });
    const { ds, s } = mk([p], [m('P', d(2), d(4))]);
    // committed 0 (not in sprint at start); added 4 at d2; removed 4 at d4
    expect(scopeChange(ds, s, { now: d(20) })).toMatchObject({
      committed: 0,
      added: 4,
      removed: 4,
      addedCount: 1,
      removedCount: 1,
    });
    expect(velocity(ds)[0]).toMatchObject({ committed: 0, completed: 0 });
    expect(carryOver(ds, s)?.count).toBe(0);
  });

  it('edge: removed then re-added', () => {
    const q = issue('Q', { created: d(-3), estimate: 3 });
    const { ds, s } = mk([q], [m('Q', d(-1), d(3)), m('Q', d(5))]);
    // committed 3; removed 3 at d3; added 3 at d5; still in the sprint at close, not done
    expect(scopeChange(ds, s, { now: d(20) })).toMatchObject({
      committed: 3,
      added: 3,
      removed: 3,
      addedCount: 1,
      removedCount: 1,
    });
    expect(carryOver(ds, s)).toMatchObject({ count: 1, points: 3 });
    expect(velocity(ds)[0]).toMatchObject({ committed: 3, completed: 0 });
  });

  it('edge: an issue reopened before close is not completed', () => {
    const r = issue('R', {
      created: d(-3),
      estimate: 5,
      steps: [
        [d(3), 'done'],
        [d(7), 'todo'],
      ],
    });
    const { ds, s } = mk([r], [m('R', d(-1))]);
    expect(velocity(ds)[0]).toMatchObject({ committed: 5, completed: 0, completedCount: 0 });
    expect(carryOver(ds, s)).toMatchObject({ count: 1, points: 5 });
  });

  it('edge: an empty sprint is all zeros', () => {
    const { ds, s } = mk([], []);
    const rows = velocity(ds);
    expect(rows[0]).toMatchObject({ committed: 0, completed: 0, committedCount: 0 });
    expect(velocitySummary(rows)).toEqual({ average: 0, sayDoRatio: null });
    expect(scopeChange(ds, s, { now: d(20) })).toMatchObject({
      committed: 0,
      added: 0,
      removed: 0,
    });
    expect(carryOver(ds, s)).toMatchObject({ count: 0, points: 0, issueKeys: [] });
  });

  it('edge: unestimated issues are worth 0 points but count as issues', () => {
    const u1 = issue('U1', { created: d(-3) });
    const u2 = issue('U2', { created: d(-3), steps: [[d(3), 'done']] });
    const { ds } = mk([u1, u2], [m('U1', d(-1)), m('U2', d(-1))]);
    expect(velocity(ds)[0]).toMatchObject({ committed: 0, completed: 0, committedCount: 2 });
    expect(velocity(ds, { unit: 'issues' })[0]).toMatchObject({ committed: 2, completed: 1 });
  });
});
