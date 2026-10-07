import { cycleStart, DAY, doneAt, type MetricIssue, percentile } from '@agile/metrics';
import type { Measure } from './schema';

const round = (value: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};
const mean = (values: readonly number[]) =>
  values.length === 0 ? null : round(values.reduce((a, b) => a + b, 0) / values.length, 1);

/** Days from first "in progress" to done, for issues that are done now. */
const cycleDays = (issues: readonly MetricIssue[]) =>
  issues.flatMap((i) => {
    const start = cycleStart(i);
    const done = doneAt(i);
    return start && done && start.getTime() < done.getTime() ? [(done.getTime() - start.getTime()) / DAY] : [];
  });

/**
 * One number for a set of issues. Points are current estimates; cycle time uses the same
 * definition as the cycle_time metric; age is for open issues. null when nothing qualifies.
 */
export function measureOf(issues: readonly MetricIssue[], measure: Measure, now: Date): number | null {
  switch (measure) {
    case 'count':
      return issues.length;
    case 'points':
      return round(
        issues.reduce((total, i) => total + (i.estimate ?? 0), 0),
        2,
      );
    case 'avg_cycle_time':
      return mean(cycleDays(issues));
    case 'p85_cycle_time': {
      const p = percentile(cycleDays(issues), 85);
      return p === null ? null : round(p, 1);
    }
    case 'avg_age':
      return mean(
        issues.filter((i) => doneAt(i) === null).map((i) => (now.getTime() - i.createdAt.getTime()) / DAY),
      );
  }
}
