import type { BoardDataset, MetricSprint } from '@agile/metrics';
import { d, issue } from '@agile/metrics/testing';
import { describe, expect, it } from 'vitest';
import { runQuery } from './run';
import { boardQuerySchema } from './schema';
import { NOW, queryDataset, S1, S2 } from './test-data';

const ds = queryDataset();
const run = (q: object, opts: { scope?: MetricSprint[]; ds?: BoardDataset } = {}) =>
  runQuery(opts.ds ?? ds, boardQuerySchema.parse({ title: 't', ...q }), {
    now: NOW,
    scope: opts.scope,
  });

describe('runQuery', () => {
  it('kpi: one value, 0 when nothing matches', () => {
    const open = { types: ['Bug'], statusCategory: ['todo', 'in_progress'] };
    expect(run({ display: 'kpi', filter: open })).toEqual({
      kind: 'kpi',
      value: 1,
      format: 'issues',
    });
    expect(run({ display: 'kpi', filter: { types: ['Epic'] } })).toEqual({
      kind: 'kpi',
      value: 0,
      format: 'issues',
    });
    expect(
      run({
        display: 'kpi',
        measure: 'avg_age',
        filter: { statusCategory: ['todo', 'in_progress'] },
      }),
    ).toEqual({ kind: 'kpi', value: 10.3, format: 'days' });
  });

  it('one dimension: largest first, ties by name, None for issues without a value', () => {
    expect(run({ display: 'bar', groupBy: ['assignee'] })).toEqual({
      kind: 'series',
      chart: 'bar',
      x: 'assignee',
      series: [{ key: 'count' }],
      rows: [
        { assignee: '@none', count: 2 },
        { assignee: 'pat', count: 2 },
        { assignee: 'sam', count: 1 },
      ],
    });
  });

  it('status categories are message tokens', () => {
    expect(run({ display: 'bar', groupBy: ['statusCategory'] })).toMatchObject({
      rows: [
        { statusCategory: '@done', count: 2 },
        { statusCategory: '@todo', count: 2 },
        { statusCategory: '@in_progress', count: 1 },
      ],
    });
  });

  it('multi-valued dimensions count an issue in each group, with a note', () => {
    expect(run({ display: 'table', groupBy: ['label'] })).toEqual({
      kind: 'table',
      columns: [
        { key: 'label', type: 'text' },
        { key: 'count', type: 'number' },
      ],
      rows: [
        ['@none', 2],
        ['api', 2],
        ['ui', 2],
      ],
      notes: [{ key: 'multiValued' }],
    });
  });

  it('points by epic as a pie', () => {
    expect(run({ display: 'pie', groupBy: ['epic'], measure: 'points' })).toEqual({
      kind: 'series',
      chart: 'pie',
      x: 'epic',
      series: [{ key: 'points' }],
      rows: [
        { epic: 'E-1 · Checkout', points: 11 },
        { epic: 'E-2 · Platform', points: 5 },
        { epic: '@none', points: 2 },
      ],
    });
  });

  it('weeks fill the window with zeros', () => {
    expect(
      run({ display: 'line', groupBy: ['createdWeek'], filter: { created: { lastDays: 30 } } }),
    ).toEqual({
      kind: 'series',
      chart: 'line',
      x: 'createdWeek',
      series: [{ key: 'count' }],
      rows: [
        { createdWeek: '2026-01-05', count: 2 },
        { createdWeek: '2026-01-12', count: 0 },
        { createdWeek: '2026-01-19', count: 0 },
        { createdWeek: '2026-01-26', count: 1 },
        { createdWeek: '2026-02-02', count: 1 },
      ],
    });
  });

  it('without a window, time dimensions keep the most recent 26 weeks or 24 months', () => {
    const old: BoardDataset = {
      ...ds,
      issues: [issue('OLD', { created: d(-273) }), issue('NEW', { created: d(0) })],
    };
    const weeks = run({ display: 'bar', groupBy: ['createdWeek'] }, { ds: old });
    if (weeks.kind !== 'series') throw new Error('series');
    expect(weeks.rows).toHaveLength(26);
    expect(weeks.rows[0]).toEqual({ createdWeek: '2025-07-14', count: 0 });
    expect(weeks.rows.at(-1)).toEqual({ createdWeek: '2026-01-05', count: 1 });
    expect(weeks.notes).toEqual([{ key: 'capped', values: { shown: 26, total: 40 } }]);

    const older: BoardDataset = {
      ...ds,
      issues: [issue('OLD', { created: d(-1000) }), issue('NEW', { created: d(0) })],
    };
    const months = run({ display: 'bar', groupBy: ['createdMonth'] }, { ds: older });
    if (months.kind !== 'series') throw new Error('series');
    expect(months.rows).toHaveLength(24);
    expect(months.rows[0]).toEqual({ createdMonth: '2024-02', count: 0 });
    expect(months.rows.at(-1)).toEqual({ createdMonth: '2026-01', count: 1 });
    expect(months.notes).toEqual([{ key: 'capped', values: { shown: 24, total: 34 } }]);
  });

  it('cycle time by type over a completion window', () => {
    expect(
      run({
        display: 'table',
        groupBy: ['type'],
        measure: 'p85_cycle_time',
        filter: { resolved: { lastDays: 60 } },
      }),
    ).toEqual({
      kind: 'table',
      columns: [
        { key: 'type', type: 'text' },
        { key: 'p85_cycle_time', type: 'days' },
      ],
      rows: [['Bug', 5]],
    });
  });

  it('sprints in chronological order, None last', () => {
    expect(run({ display: 'line', groupBy: ['sprint'], measure: 'points' })).toEqual({
      kind: 'series',
      chart: 'line',
      x: 'sprint',
      series: [{ key: 'points' }],
      rows: [
        { sprint: 'Sprint 1', points: 3 },
        { sprint: 'Sprint 2', points: 13 },
        { sprint: 'Sprint 3', points: 10 },
        { sprint: '@none', points: 0 },
      ],
      notes: [{ key: 'multiValued' }],
    });
  });

  it('two dimensions as stacked bars, one series per second value', () => {
    expect(
      run({
        display: 'stacked_bar',
        groupBy: ['sprint', 'type'],
        filter: { sprints: [{ lastClosed: 2 }, 'active'] },
      }),
    ).toEqual({
      kind: 'series',
      chart: 'bar',
      x: 'sprint',
      series: [
        { key: 's0', label: 'Bug', stacked: true },
        { key: 's1', label: 'Story', stacked: true },
      ],
      rows: [
        { sprint: 'Sprint 1', s0: 1, s1: 0 },
        { sprint: 'Sprint 2', s0: 1, s1: 1 },
        { sprint: 'Sprint 3', s0: 0, s1: 2 },
      ],
      pivot: 'type',
      notes: [{ key: 'multiValued' }],
    });
  });

  it('a pivot table labels its value columns', () => {
    expect(run({ display: 'table', groupBy: ['type', 'priority'] })).toEqual({
      kind: 'table',
      columns: [
        { key: 'type', type: 'text' },
        { key: 's0', type: 'number', label: 'High' },
        { key: 's1', type: 'number', label: 'Medium' },
        { key: 's2', type: 'number', label: 'Low' },
      ],
      rows: [
        ['Bug', 2, 1, 0],
        ['Story', 0, 1, 1],
      ],
      pivot: 'priority',
    });
  });

  it('names the second dimension, so its month labels can be formatted', () => {
    const data = run({
      display: 'table',
      groupBy: ['type', 'createdMonth'],
      filter: { created: { lastDays: 60 } },
    });
    if (data.kind !== 'table') throw new Error(data.kind);
    expect(data.pivot).toBe('createdMonth');
    expect(data.columns.length).toBeGreaterThan(2);
    expect(data.columns.slice(1).every((c) => /^\d{4}-\d{2}$/.test(c.label ?? ''))).toBe(true);
  });

  it('lists issues with the chosen columns, sorted (empty values last) and limited', () => {
    expect(
      run({
        display: 'list',
        filter: { assignees: [null] },
        list: {
          columns: ['key', 'summary', 'status', 'points', 'age'],
          sort: { by: 'points', dir: 'desc' },
        },
      }),
    ).toEqual({
      kind: 'table',
      columns: [
        { key: 'key', type: 'text' },
        { key: 'summary', type: 'text' },
        { key: 'status', type: 'text' },
        { key: 'points', type: 'number' },
        { key: 'age', type: 'days' },
      ],
      rows: [
        ['D', 'Summary of D', 'To Do', 2, 5],
        ['E', 'Summary of E', 'To Do', null, 1],
      ],
    });
    expect(run({ display: 'list', list: { columns: ['key'], limit: 2 } })).toEqual({
      kind: 'table',
      columns: [{ key: 'key', type: 'text' }],
      rows: [['A'], ['B']],
      notes: [{ key: 'capped', values: { shown: 2, total: 5 } }],
    });
  });

  it('top keeps the largest groups and folds the rest into Other', () => {
    expect(run({ display: 'bar', groupBy: ['assignee'], top: 1 })).toMatchObject({
      rows: [
        { assignee: '@none', count: 2 },
        { assignee: '@other', count: 3 },
      ],
    });
  });

  it('caps categories at 20 with a note', () => {
    const many: BoardDataset = {
      ...ds,
      issues: Array.from({ length: 25 }, (_, i) =>
        issue(`X${i}`, { created: d(1), assignee: `p${String(i).padStart(2, '0')}` }),
      ),
    };
    const data = run({ display: 'bar', groupBy: ['assignee'] }, { ds: many });
    if (data.kind !== 'series') throw new Error('series');
    expect(data.rows).toHaveLength(21);
    expect(data.rows.at(-1)).toEqual({ assignee: '@other', count: 5 });
    expect(data.notes).toEqual([{ key: 'capped', values: { shown: 20, total: 25 } }]);
  });

  it('keeps the 20 most recent sprints', () => {
    const sprints = Array.from({ length: 25 }, (_, i) => ({
      ...S1,
      id: `k${i}`,
      name: `K${i}`,
      startAt: d(i),
      members: [{ issueId: 'A', addedAt: d(i), removedAt: null }],
    }));
    const [a] = ds.issues;
    if (!a) throw new Error('fixture');
    const data = run(
      { display: 'bar', groupBy: ['sprint'] },
      { ds: { ...ds, sprints, issues: [a] } },
    );
    if (data.kind !== 'series') throw new Error('series');
    expect(data.rows.map((r) => r.sprint)).toEqual(
      Array.from({ length: 20 }, (_, i) => `K${i + 5}`),
    );
    expect(data.notes).toEqual([
      { key: 'multiValued' },
      { key: 'capped', values: { shown: 20, total: 25 } },
    ]);
  });

  it('a second time dimension keeps only the 8 most recent buckets, with a note', () => {
    expect(
      run({
        display: 'stacked_bar',
        groupBy: ['type', 'createdWeek'],
        filter: { created: { lastDays: 730 } },
      }),
    ).toEqual({
      kind: 'series',
      chart: 'bar',
      x: 'type',
      series: [
        { key: 's0', label: '2025-12-15', stacked: true },
        { key: 's1', label: '2025-12-22', stacked: true },
        { key: 's2', label: '2025-12-29', stacked: true },
        { key: 's3', label: '2026-01-05', stacked: true },
        { key: 's4', label: '2026-01-12', stacked: true },
        { key: 's5', label: '2026-01-19', stacked: true },
        { key: 's6', label: '2026-01-26', stacked: true },
        { key: 's7', label: '2026-02-02', stacked: true },
      ],
      rows: [
        { type: 'Bug', s0: 0, s1: 0, s2: 1, s3: 1, s4: 0, s5: 0, s6: 0, s7: 1 },
        { type: 'Story', s0: 0, s1: 0, s2: 0, s3: 1, s4: 0, s5: 0, s6: 1, s7: 0 },
      ],
      pivot: 'createdWeek',
      notes: [{ key: 'capped', values: { shown: 8, total: 105 } }],
    });
  });

  it('capping sprints keeps the most recent started ones, not planned (future) ones', () => {
    const started = Array.from({ length: 22 }, (_, i) => ({
      ...S1,
      id: `s${i}`,
      name: `S${i}`,
      startAt: d(i),
      members: [{ issueId: 'A', addedAt: d(i), removedAt: null }],
    }));
    const future = Array.from({ length: 3 }, (_, i) => ({
      ...S1,
      id: `f${i}`,
      name: `F${i}`,
      state: 'future' as const,
      startAt: null,
      endAt: null,
      members: [{ issueId: 'A', addedAt: d(0), removedAt: null }],
    }));
    const [a] = ds.issues;
    if (!a) throw new Error('fixture');
    const data = run(
      { display: 'bar', groupBy: ['sprint'] },
      { ds: { ...ds, sprints: [...started, ...future], issues: [a] } },
    );
    if (data.kind !== 'series') throw new Error('series');
    expect(data.rows.map((r) => r.sprint)).toEqual(
      Array.from({ length: 20 }, (_, i) => `S${i + 2}`),
    );
    expect(data.notes).toEqual([
      { key: 'multiValued' },
      { key: 'capped', values: { shown: 20, total: 25 } },
    ]);
  });

  it('points fall back to counts on a board without estimates', () => {
    expect(
      run({ display: 'kpi', measure: 'points' }, { ds: { ...ds, hasEstimates: false } }),
    ).toEqual({
      kind: 'kpi',
      value: 5,
      format: 'issues',
      notes: [{ key: 'pointsAsCount' }],
    });
  });

  it('notes fields that are still syncing', () => {
    expect(
      run({ display: 'table', groupBy: ['label'] }, { ds: { ...ds, fieldsSynced: false } }),
    ).toMatchObject({
      notes: [{ key: 'fieldsSyncing' }, { key: 'multiValued' }],
    });
    expect(
      run({ display: 'table', groupBy: ['type'] }, { ds: { ...ds, fieldsSynced: false } }),
    ).not.toHaveProperty('notes');
  });

  it('nothing to group or list: no_match', () => {
    expect(run({ display: 'bar', groupBy: ['type'], filter: { types: ['Epic'] } })).toEqual({
      kind: 'empty',
      reason: 'no_match',
    });
    expect(
      run({ display: 'list', list: { columns: ['key'] }, filter: { types: ['Epic'] } }),
    ).toEqual({
      kind: 'empty',
      reason: 'no_match',
    });
  });

  it('follows the dashboard sprint selection unless the query names sprints', () => {
    expect(run({ display: 'kpi' }, { scope: [S2] })).toEqual({
      kind: 'kpi',
      value: 2,
      format: 'issues',
    });
    expect(run({ display: 'kpi', filter: { sprints: ['active'] } }, { scope: [S2] })).toEqual({
      kind: 'kpi',
      value: 2,
      format: 'issues',
      unfiltered: true,
    });
  });
});
