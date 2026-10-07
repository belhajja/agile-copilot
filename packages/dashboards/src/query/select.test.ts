import { describe, expect, it } from 'vitest';
import { boardQuerySchema } from './schema';
import { selectIssues, sprintsByIssue } from './select';
import { NOW, queryDataset, S2 } from './test-data';

const ds = queryDataset();
const keys = (filter: object, scope?: (typeof S2)[]) =>
  selectIssues(ds, boardQuerySchema.parse({ title: 't', display: 'kpi', filter }), {
    now: NOW,
    scope,
    sprintsOf: sprintsByIssue(ds),
  }).map((i) => i.key);

describe('selectIssues', () => {
  it('keeps everything without a filter', () => {
    expect(keys({})).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('matches names whatever their case and spacing', () => {
    expect(keys({ types: ['bug'] })).toEqual(['A', 'B', 'E']);
    expect(keys({ statuses: [' in progress '] })).toEqual(['C']);
    expect(keys({ assignees: ['PAT'] })).toEqual(['A', 'C']);
    expect(keys({ priorities: ['high'] })).toEqual(['A', 'B']);
    expect(keys({ components: ['web'] })).toEqual(['A']);
    expect(keys({ fixVersions: ['1.0'] })).toEqual(['B']);
  });

  it('filters on categories, unassigned, labels and epics (key or name)', () => {
    expect(keys({ statusCategory: ['todo', 'in_progress'] })).toEqual(['C', 'D', 'E']);
    expect(keys({ assignees: [null] })).toEqual(['D', 'E']);
    expect(keys({ labels: ['api'] })).toEqual(['B', 'D']);
    expect(keys({ epics: ['checkout'] })).toEqual(['A', 'C']);
    expect(keys({ epics: ['E-2'] })).toEqual(['B']);
  });

  it('resolves sprint references against the board', () => {
    expect(keys({ sprints: ['last_closed'] })).toEqual(['B', 'C']);
    expect(keys({ sprints: ['active'] })).toEqual(['C', 'D']);
    expect(keys({ sprints: [{ lastClosed: 2 }] })).toEqual(['A', 'B', 'C']);
    expect(keys({ sprints: [{ id: 's1' }] })).toEqual(['A']);
    // list_sprints gives the model Jira's sprint number: as text or as a number.
    expect(keys({ sprints: [{ id: '102' }] })).toEqual(['B', 'C']);
    expect(keys({ sprints: [{ id: 102 }] })).toEqual(['B', 'C']);
    expect(keys({ sprints: [{ id: 'nope' }] })).toEqual([]);
  });

  it('applies relative windows on creation and completion', () => {
    expect(keys({ created: { lastDays: 30 } })).toEqual(['B', 'C', 'D', 'E']);
    expect(keys({ resolved: { lastDays: 20 } })).toEqual(['B']);
    expect(keys({ resolved: { sinceSprintsAgo: 1 } })).toEqual([]);
    expect(keys({ resolved: { sinceSprintsAgo: 3 } })).toEqual(['A', 'B']);
  });

  it('combines filters with AND, and unknown names match nothing', () => {
    expect(keys({ types: ['Bug'], statusCategory: ['todo'] })).toEqual(['E']);
    expect(keys({ types: ['Epic'] })).toEqual([]);
  });

  it('follows the dashboard selection unless the query names its sprints', () => {
    expect(keys({}, [S2])).toEqual(['B', 'C']);
    expect(keys({ sprints: ['active'] }, [S2])).toEqual(['C', 'D']);
  });
});
