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
});
