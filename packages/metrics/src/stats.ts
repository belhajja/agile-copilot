import type { Interval } from './model';

/**
 * Nearest-rank percentile: the smallest value with at least p% of values at or below it.
 * Chosen because it always returns an observed value and is easy to verify by hand.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? null;
}

export const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

export const round = (value: number, digits = 2): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

/** Sum rounded to 2 decimals (hides float noise in reported totals). */
export const total = (values: readonly number[]): number => round(sum(values), 2);

/** Total milliseconds covered by the union of the intervals, clipped to [from, to]. */
export function coveredMs(intervals: readonly Interval[], from: Date, to: Date): number {
  const clipped = intervals
    .map((i) => ({
      start: Math.max(i.from.getTime(), from.getTime()),
      end: Math.min((i.to ?? to).getTime(), to.getTime()),
    }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = Number.NaN;
  let curEnd = Number.NaN;
  for (const i of clipped) {
    if (Number.isNaN(curStart) || i.start > curEnd) {
      if (!Number.isNaN(curStart)) total += curEnd - curStart;
      curStart = i.start;
      curEnd = i.end;
    } else {
      curEnd = Math.max(curEnd, i.end);
    }
  }
  if (!Number.isNaN(curStart)) total += curEnd - curStart;
  return total;
}
