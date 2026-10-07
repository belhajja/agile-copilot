import { describe, expect, it } from 'vitest';
import { boardQuerySchema } from './schema';

const paths = (q: object) => {
  const r = boardQuerySchema.safeParse(q);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};

const EXAMPLES = [
  {
    title: 'Open bugs per assignee',
    filter: { types: ['Bug'], statusCategory: ['todo', 'in_progress'] },
    groupBy: ['assignee'],
    display: 'bar',
  },
  {
    title: 'Points per sprint by type',
    filter: { sprints: [{ lastClosed: 6 }] },
    groupBy: ['sprint', 'type'],
    measure: 'points',
    display: 'stacked_bar',
  },
  {
    title: 'Bugs created per week',
    filter: { types: ['Bug'], created: { lastDays: 90 } },
    groupBy: ['createdWeek'],
    display: 'line',
  },
  {
    title: 'Unassigned in progress',
    filter: { assignees: [null], statusCategory: ['in_progress'] },
    display: 'list',
    list: { columns: ['key', 'summary', 'status'] },
  },
  {
    title: 'Cycle time by type',
    filter: { resolved: { lastDays: 60 } },
    groupBy: ['type'],
    measure: 'p85_cycle_time',
    display: 'table',
  },
];

describe('boardQuerySchema', () => {
  it('accepts the design examples', () => {
    for (const q of EXAMPLES) expect(paths(q)).toEqual([]);
  });

  it('defaults the measure, the list limit and the sort direction', () => {
    expect(boardQuerySchema.parse({ title: 't', display: 'kpi' }).measure).toBe('count');
    expect(
      boardQuerySchema.parse({
        title: 't',
        display: 'list',
        list: { columns: ['key'], sort: { by: 'key' } },
      }).list,
    ).toEqual({ columns: ['key'], sort: { by: 'key', dir: 'asc' }, limit: 20 });
  });

  it('refuses displays that do not fit the grouping', () => {
    expect(paths({ title: 't', display: 'kpi', groupBy: ['type'] })).toEqual(['groupBy']);
    expect(paths({ title: 't', display: 'pie', groupBy: ['type', 'assignee'] })).toEqual([
      'groupBy',
    ]);
    expect(paths({ title: 't', display: 'line', groupBy: ['assignee'] })).toEqual(['groupBy']);
    expect(paths({ title: 't', display: 'stacked_bar', groupBy: ['type'] })).toEqual(['groupBy']);
    expect(paths({ title: 't', display: 'table' })).toEqual(['groupBy']);
    expect(
      paths({ title: 't', display: 'list', groupBy: ['type'], list: { columns: ['key'] } }),
    ).toEqual(['groupBy']);
    expect(paths({ title: 't', display: 'list' })).toEqual(['list']);
    expect(
      paths({ title: 't', display: 'bar', groupBy: ['type'], list: { columns: ['key'] } }),
    ).toEqual(['list']);
    expect(paths({ title: 't', display: 'table', groupBy: ['type', 'type'] })).toEqual(['groupBy']);
    expect(paths({ title: 't', display: 'pie', groupBy: ['type'], measure: 'avg_age' })).toEqual([
      'measure',
    ]);
    expect(paths({ title: 't', display: 'line', groupBy: ['createdWeek'], top: 5 })).toEqual([
      'top',
    ]);
    expect(paths({ title: 't', display: 'line', groupBy: ['sprint'] })).toEqual([]);
  });

  it('refuses unknown keys, long value lists and control characters', () => {
    expect(paths({ title: 't', display: 'kpi', jql: 'project = X' })).toEqual(['']);
    expect(
      paths({
        title: 't',
        display: 'kpi',
        filter: { labels: Array.from({ length: 11 }, (_, i) => `l${i}`) },
      }),
    ).toEqual(['filter.labels']);
    expect(paths({ title: 'a‮b', display: 'kpi' })).toEqual(['title']);
    const sprintPaths = paths({
      title: 't',
      display: 'kpi',
      filter: { sprints: [{ lastClosed: 21 }] },
    });
    expect(sprintPaths.some((p) => p.startsWith('filter.sprints.0'))).toBe(true);
  });

  it('refuses a query over 4 KB', () => {
    const long = Array.from({ length: 10 }, (_, i) => `${'x'.repeat(95)}${i}`);
    expect(
      paths({
        title: 't',
        display: 'kpi',
        filter: {
          labels: long,
          components: long,
          fixVersions: long,
          priorities: long,
          types: long,
        },
      }),
    ).toEqual(['']);
  });
});
