import { uniformInt } from 'pure-rand/distribution/uniformInt';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import { doneAt } from './issue';
import type { BoardDataset } from './model';
import { addDays, isoDay, startOfUtcDay } from './time';

export interface Forecast {
  p50: number;
  p85: number;
  p95: number;
}

/** A forecast needs at least one finished item in the history. */
const hasThroughput = (samples: readonly number[]) => samples.some((s) => s > 0);

const validTrials = (trials: number) => Number.isFinite(trials) && trials >= 1;

/** Items finished on each of the last `historyDays` full UTC days (today excluded). */
export function dailyThroughputSamples(
  ds: BoardDataset,
  opts: { historyDays?: number; now: Date },
): number[] {
  const days = opts.historyDays ?? 30;
  const today = startOfUtcDay(opts.now);
  const keys = Array.from({ length: days }, (_, i) => isoDay(addDays(today, i - days)));
  const counts = new Map(keys.map((k) => [k, 0]));
  for (const issue of ds.issues) {
    const end = doneAt(issue);
    if (!end) continue;
    const k = isoDay(end);
    const n = counts.get(k);
    if (n !== undefined) counts.set(k, n + 1);
  }
  return keys.map((k) => counts.get(k) ?? 0);
}

/**
 * "How many items will be finished in the next `days` days?" Each trial sums `days` throughput
 * values drawn (with replacement) from past days. pXX is the count reached in at least XX% of
 * trials, so p95 <= p85 <= p50. null when there is no history.
 */
export function forecastHowMany(
  samples: readonly number[],
  opts: { days: number; trials?: number; seed?: number },
): Forecast | null {
  const trials = opts.trials ?? 10_000;
  if (!hasThroughput(samples) || !(opts.days >= 1) || !validTrials(trials)) return null;
  const rng = xoroshiro128plus(opts.seed ?? 42);
  const totals: number[] = [];
  for (let trial = 0; trial < trials; trial++) {
    let total = 0;
    for (let d = 0; d < opts.days; d++)
      total += samples[uniformInt(rng, 0, samples.length - 1)] ?? 0;
    totals.push(total);
  }
  totals.sort((a, b) => a - b);
  const atLeast = (p: number) => totals[Math.floor((1 - p / 100) * trials)] ?? 0;
  return { p50: atLeast(50), p85: atLeast(85), p95: atLeast(95) };
}

/**
 * "In how many days will `items` items be finished?" pXX is the number of days within which XX%
 * of trials finished, so p50 <= p85 <= p95. Trials are capped at `maxDays`. null when the history
 * has no finished items (no forecast is possible). `capped` is true when a percentile hit
 * `maxDays`, i.e. the real answer is later than reported.
 */
export function forecastWhen(
  samples: readonly number[],
  opts: { items: number; trials?: number; seed?: number; maxDays?: number },
): (Forecast & { capped: boolean }) | null {
  const trials = opts.trials ?? 10_000;
  if (!hasThroughput(samples) || !(opts.items >= 1) || !validTrials(trials)) return null;
  const maxDays = opts.maxDays ?? 730;
  const rng = xoroshiro128plus(opts.seed ?? 42);
  const durations: number[] = [];
  for (let trial = 0; trial < trials; trial++) {
    let total = 0;
    let days = 0;
    while (total < opts.items && days < maxDays) {
      total += samples[uniformInt(rng, 0, samples.length - 1)] ?? 0;
      days++;
    }
    durations.push(days);
  }
  durations.sort((a, b) => a - b);
  const within = (p: number) =>
    durations[Math.min(trials, Math.max(1, Math.ceil((p / 100) * trials))) - 1] ?? maxDays;
  const result = { p50: within(50), p85: within(85), p95: within(95) };
  return {
    ...result,
    capped: result.p50 === maxDays || result.p85 === maxDays || result.p95 === maxDays,
  };
}
