import { describe, expect, it } from 'vitest';
import { d, flowFixture, issue } from './fixtures';
import { dailyThroughputSamples, forecastHowMany, forecastWhen } from './forecast';

describe('Monte Carlo forecasting', () => {
  it('collects daily throughput for the last full days', () => {
    // d20..d29; only K4 finished in that range (d26)
    expect(dailyThroughputSamples(flowFixture(), { now: d(30, 15), historyDays: 10 })).toEqual([
      0, 0, 0, 0, 0, 0, 1, 0, 0, 0,
    ]);
  });

  it('is exact when throughput never varies', () => {
    expect(forecastHowMany([2, 2, 2], { days: 10 })).toEqual({ p50: 20, p85: 20, p95: 20 });
    expect(forecastWhen([2, 2, 2], { items: 7 })).toEqual({
      p50: 4,
      p85: 4,
      p95: 4,
      capped: false,
    });
  });

  it('is deterministic for a seed and ordered by confidence', () => {
    const samples = [0, 1, 0, 3, 2, 0, 1, 4, 0, 2];
    const a = forecastHowMany(samples, { days: 14, seed: 7 });
    expect(forecastHowMany(samples, { days: 14, seed: 7 })).toEqual(a);
    expect(a && a.p95 <= a.p85 && a.p85 <= a.p50).toBe(true);
    const w = forecastWhen(samples, { items: 20, seed: 7 });
    expect(forecastWhen(samples, { items: 20, seed: 7 })).toEqual(w);
    expect(w && w.p50 <= w.p85 && w.p85 <= w.p95).toBe(true);
    // Mean throughput is 1.3/day, so 20 items take about 15 days at the median.
    expect(w?.p50).toBeGreaterThanOrEqual(12);
    expect(w?.p50).toBeLessThanOrEqual(19);
  });

  it('refuses to forecast without history', () => {
    expect(forecastHowMany([], { days: 5 })).toBeNull();
    expect(forecastWhen([0, 0, 0], { items: 3 })).toBeNull();
  });

  it('caps runaway trials at maxDays', () => {
    const capped = forecastWhen([1, 0, 0, 0, 0, 0, 0, 0, 0, 0], {
      items: 50,
      maxDays: 30,
      trials: 200,
    });
    expect(capped?.p95).toBe(30);
    expect(capped?.capped).toBe(true);
  });

  it('reports capped: false for normal forecasts', () => {
    expect(forecastWhen([2, 2, 2], { items: 7 })).toEqual({
      p50: 4,
      p85: 4,
      p95: 4,
      capped: false,
    });
  });

  it('refuses to forecast how many from an all-zero history', () => {
    expect(forecastHowMany([0, 0, 0], { days: 5 })).toBeNull();
  });

  it('guards invalid trials and days', () => {
    for (const trials of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(forecastHowMany([1, 2], { days: 5, trials })).toBeNull();
      expect(forecastWhen([1, 2], { items: 5, trials })).toBeNull();
    }
    expect(forecastHowMany([1, 2], { days: 0 })).toBeNull();
    expect(forecastHowMany([1, 2], { days: -3 })).toBeNull();
  });
});

describe('Monte Carlo: edge cases', () => {
  it('has no history for an empty dataset', () => {
    const empty = { issues: [], sprints: [], hasEstimates: true };
    const samples = dailyThroughputSamples(empty, { now: d(30), historyDays: 3 });
    expect(samples).toEqual([0, 0, 0]);
    expect(forecastWhen(samples, { items: 1 })).toBeNull();
  });

  it('counts only the final done of a reopened issue', () => {
    const ds = {
      issues: [
        issue('R', {
          created: d(0),
          steps: [
            [d(1), 'done'],
            [d(2), 'in_progress'],
            [d(4), 'done'],
          ],
        }),
      ],
      sprints: [],
      hasEstimates: true,
    };
    expect(dailyThroughputSamples(ds, { now: d(6), historyDays: 6 })).toEqual([0, 0, 0, 0, 1, 0]);
  });
});
