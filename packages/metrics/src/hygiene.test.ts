import { describe, expect, it } from 'vitest';
import { d, flowFixture } from './fixtures';
import { hygiene } from './hygiene';

describe('hygiene (golden: flowFixture, now = d30)', () => {
  it('flags stale, unestimated, unassigned in-progress and oversized open issues', () => {
    const findings = hygiene(flowFixture(), { now: d(30) });
    expect(findings.map((f) => [f.key, f.problems])).toEqual([
      ['K5', ['stale', 'oversized']], // updated d10 (20 days ago), 21 pts > 13
      ['K6', ['unassigned_in_progress']],
      ['K7', ['missing_estimate']],
    ]);
  });

  it('does not ask for estimates on boards that do not estimate', () => {
    const findings = hygiene({ ...flowFixture(), hasEstimates: false }, { now: d(30) });
    expect(findings.map((f) => f.key)).toEqual(['K5', 'K6']);
  });

  it('honours custom thresholds', () => {
    const findings = hygiene(flowFixture(), { now: d(30), staleDays: 30, oversizedPoints: 50 });
    expect(findings.map((f) => [f.key, f.problems])).toEqual([
      ['K6', ['unassigned_in_progress']],
      ['K7', ['missing_estimate']],
    ]);
  });
});

describe('hygiene: edge cases', () => {
  it('asks for estimates on every open issue when all estimates are null, never flags done ones', () => {
    const ds = flowFixture();
    const bare = {
      ...ds,
      issues: ds.issues.map((i) => ({ ...i, estimate: null })),
    };
    expect(hygiene(bare, { now: d(30) }).map((f) => [f.key, f.problems])).toEqual([
      ['K5', ['stale', 'missing_estimate']],
      ['K6', ['missing_estimate', 'unassigned_in_progress']],
      ['K7', ['missing_estimate']],
    ]);
    expect(hygiene({ ...bare, hasEstimates: false }, { now: d(30) }).map((f) => f.key)).toEqual([
      'K5',
      'K6',
    ]);
  });

  it('returns nothing for an empty dataset', () => {
    expect(hygiene({ issues: [], sprints: [], hasEstimates: true }, { now: d(30) })).toEqual([]);
  });
});
