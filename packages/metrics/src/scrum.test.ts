import { describe, expect, it } from 'vitest';
import { d, scrumFixture } from './fixtures';
import {
  carryOver,
  currentSprint,
  scopeChange,
  sprintBurn,
  velocity,
  velocitySummary,
} from './scrum';

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
    expect(rows.slice(2, 5).map((r) => r.remaining)).toEqual([17, 12, null]);
    expect(currentSprint({ ...ds, sprints: [active] })?.id).toBe('s1');
  });
});
