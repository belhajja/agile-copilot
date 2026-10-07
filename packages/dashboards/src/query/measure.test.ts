import { cycleTime } from '@agile/metrics';
import { d, issue } from '@agile/metrics/testing';
import { describe, expect, it } from 'vitest';
import { measureOf } from './measure';
import { NOW, queryDataset } from './test-data';

const issues = queryDataset().issues;
const only = (...keys: string[]) => issues.filter((i) => keys.includes(i.key));

describe('measureOf', () => {
  it('counts issues and sums current estimates', () => {
    expect(measureOf(issues, 'count', NOW)).toBe(5);
    expect(measureOf(issues, 'points', NOW)).toBe(18); // 3 + 5 + 8 + 2 + 0
    expect(measureOf([], 'count', NOW)).toBe(0);
  });

  it('averages and takes the 85th percentile of cycle time over finished issues', () => {
    // A: d1 → d4 = 3 days; B: d15 → d20 = 5 days.
    expect(measureOf(issues, 'avg_cycle_time', NOW)).toBe(4);
    expect(measureOf(issues, 'p85_cycle_time', NOW)).toBe(5);
    expect(measureOf(only('C'), 'avg_cycle_time', NOW)).toBeNull();
  });

  it('averages the age of open issues', () => {
    // C 25 days, D 5, E 1 → 31 / 3 = 10.33.
    expect(measureOf(issues, 'avg_age', NOW)).toBe(10.3);
    expect(measureOf(only('A'), 'avg_age', NOW)).toBeNull();
  });

  it('excludes issues when done happens at or before in-progress (matching cycleTime metric)', () => {
    // Create issues with edge cases: same time and done before in-progress
    const sameTime = issue('SAME', {
      created: d(0),
      steps: [
        [d(5), 'in_progress', false],
        [d(5), 'done'],
      ],
    });
    const doneBefore = issue('BEFORE', {
      created: d(0),
      steps: [
        [d(6), 'done'],
        [d(4), 'in_progress'],
      ],
    });
    const normal = issue('NORMAL', {
      created: d(0),
      steps: [
        [d(2), 'in_progress'],
        [d(5), 'done'],
      ],
    });

    const ds = { issues: [sameTime, doneBefore, normal], sprints: [], hasEstimates: false };
    const ct = cycleTime(ds, { now: NOW });

    // Only NORMAL should have cycle time; SAME and BEFORE should have null cycle time
    expect(ct.count).toBe(1); // Only one issue has valid cycle time
    expect(measureOf([sameTime], 'avg_cycle_time', NOW)).toBeNull();
    expect(measureOf([doneBefore], 'avg_cycle_time', NOW)).toBeNull();
    expect(measureOf([normal], 'avg_cycle_time', NOW)).toBe(3); // d2 → d5 = 3 days
  });
});
