import type { BoardDataset, MetricIssue } from '@agile/metrics';
import { describe, expect, it } from 'vitest';
import { computeMetric, MAX_TABLE_ROWS, metricSpec } from './metrics';

const NOW = new Date('2026-10-04T08:00:00Z');
const OLD = new Date('2026-01-01T00:00:00Z');

/** `n` open, unestimated, stale issues: each one is a hygiene finding (one table row). */
function staleBoard(n: number): BoardDataset {
  const issues: MetricIssue[] = Array.from({ length: n }, (_, i) => ({
    id: `i${i}`,
    key: `DEMO-${i + 1}`,
    summary: `Issue ${i + 1}`,
    type: 'Story',
    createdAt: OLD,
    updatedAt: OLD,
    assignee: null,
    estimate: null,
    estimateChanges: [],
    statusPeriods: [{ from: OLD, category: 'todo', blocked: false }],
    flagged: [],
  }));
  return { issues, sprints: [], hasEstimates: true };
}

const hygieneSpec = () => {
  const spec = metricSpec('hygiene', {});
  if (!spec.ok) throw new Error('hygiene spec');
  return spec.spec;
};

describe('computeMetric (tool layer)', () => {
  it('caps tables at 50 rows and says so', () => {
    const data = computeMetric(hygieneSpec(), staleBoard(60), NOW);
    expect(MAX_TABLE_ROWS).toBe(50);
    expect(data).toMatchObject({ kind: 'table', totalRows: 60, truncated: true });
    if (data.kind !== 'table') throw new Error('table expected');
    expect(data.rows).toHaveLength(50);
    expect(data.rows[0]?.[0]).toBe('DEMO-1');
    expect(data.rows[49]?.[0]).toBe('DEMO-50');
  });

  it('leaves tables within the cap untouched', () => {
    const data = computeMetric(hygieneSpec(), staleBoard(50), NOW);
    if (data.kind !== 'table') throw new Error('table expected');
    expect(data.rows).toHaveLength(50);
    expect(data).not.toHaveProperty('truncated');
    expect(data).not.toHaveProperty('totalRows');
  });
});
