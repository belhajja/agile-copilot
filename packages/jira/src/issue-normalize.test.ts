import { describe, expect, it } from 'vitest';
import {
  buildIssueJql,
  deriveSprintMembership,
  findEpicLinkField,
  issueFieldList,
  normalizeIssue,
  parseJiraDate,
  parseSprintField,
  suggestStatusMapping,
} from './issue-normalize';
import { historySchema } from './responses';
import type { IssueFieldContext, RawIssue } from './sync-types';

const ctx: IssueFieldContext = {
  estimationFieldId: 'customfield_10016',
  estimationFieldName: 'Story Points',
  sprintFieldId: 'customfield_10020',
};
const history = (id: string, created: string, items: Record<string, unknown>[]) =>
  historySchema.parse({ id, created, items });

const raw: RawIssue = {
  id: '10001',
  key: 'DEMO-1',
  fields: {
    summary: 'Checkout flow',
    issuetype: { name: 'Story', subtask: false },
    status: { id: '10003', name: 'Done' },
    assignee: { accountId: 'u-1', displayName: 'Alex' },
    created: '2026-01-01T09:00:00.000+0100',
    updated: '2026-01-09T10:00:00.000+0000',
    resolutiondate: '2026-01-09T10:00:00.000+0000',
    customfield_10016: 5,
    customfield_10020: [
      { id: 1, name: 'Sprint 1' },
      { id: 2, name: 'Sprint 2' },
    ],
  },
};

describe('parseJiraDate', () => {
  it('reads Jira offsets without a colon', () => {
    expect(parseJiraDate('2026-01-01T09:00:00.000+0100')?.toISOString()).toBe(
      '2026-01-01T08:00:00.000Z',
    );
    expect(parseJiraDate('2026-01-01T09:00:00.000Z')?.toISOString()).toBe(
      '2026-01-01T09:00:00.000Z',
    );
    expect(parseJiraDate('garbage')).toBeNull();
    expect(parseJiraDate(null)).toBeNull();
  });
});

describe('parseSprintField', () => {
  it('reads Cloud objects and legacy Data Center strings', () => {
    expect(parseSprintField([{ id: 3 }, { id: 4 }])).toEqual([3, 4]);
    expect(
      parseSprintField([
        'com.atlassian.greenhopper.service.sprint.Sprint@1a2b[id=12,rapidViewId=3,state=CLOSED,name=S12]',
      ]),
    ).toEqual([12]);
    expect(parseSprintField(null)).toEqual([]);
  });
});

describe('deriveSprintMembership', () => {
  const t = (iso: string) => new Date(iso);
  it('keeps closed sprints when an issue is carried over', () => {
    expect(
      deriveSprintMembership(
        t('2026-01-01T00:00:00Z'),
        [1, 2],
        [
          { at: t('2026-01-02T00:00:00Z'), from: [], to: [1] },
          { at: t('2026-01-15T00:00:00Z'), from: [1], to: [1, 2] },
        ],
      ),
    ).toEqual([
      { jiraSprintId: 1, addedAt: t('2026-01-02T00:00:00Z'), removedAt: null },
      { jiraSprintId: 2, addedAt: t('2026-01-15T00:00:00Z'), removedAt: null },
    ]);
  });

  it('records removals and issues created inside a sprint', () => {
    expect(
      deriveSprintMembership(
        t('2026-01-01T00:00:00Z'),
        [],
        [{ at: t('2026-01-05T00:00:00Z'), from: [7], to: [] }],
      ),
    ).toEqual([
      { jiraSprintId: 7, addedAt: t('2026-01-01T00:00:00Z'), removedAt: t('2026-01-05T00:00:00Z') },
    ]);
    expect(deriveSprintMembership(t('2026-01-01T00:00:00Z'), [9], [])).toEqual([
      { jiraSprintId: 9, addedAt: t('2026-01-01T00:00:00Z'), removedAt: null },
    ]);
  });
});

describe('normalizeIssue', () => {
  it('extracts transitions, estimate and flag changes, and sprint membership in time order', () => {
    // Histories deliberately newest-first, as some Jira endpoints return them.
    const histories = [
      history('103', '2026-01-09T10:00:00.000+0000', [
        {
          field: 'status',
          fieldId: 'status',
          from: '3',
          fromString: 'In Progress',
          to: '10003',
          toString: 'Done',
        },
      ]),
      history('102', '2026-01-04T10:00:00.000+0000', [
        {
          field: 'Story Points',
          fieldId: 'customfield_10016',
          from: null,
          fromString: '3',
          to: null,
          toString: '5',
        },
        { field: 'Flagged', from: null, fromString: null, to: '[10019]', toString: 'Impediment' },
        {
          field: 'Sprint',
          fieldId: 'customfield_10020',
          from: '1',
          fromString: 'Sprint 1',
          to: '1, 2',
          toString: 'Sprint 1, Sprint 2',
        },
      ]),
      history('101', '2026-01-02T10:00:00.000+0000', [
        { field: 'Sprint', from: null, to: '1' },
        { field: 'status', from: '10000', to: '3' }, // no fromString/toString keys at all
        { field: 'Flagged', from: '[10019]', fromString: 'Impediment', to: null }, // unflag
      ]),
    ];
    const n = normalizeIssue(raw, histories, ctx);
    expect(n).toMatchObject({
      jiraIssueId: '10001',
      key: 'DEMO-1',
      summary: 'Checkout flow',
      issueType: 'Story',
      isSubtask: false,
      statusId: '10003',
      assigneeId: 'u-1',
      assigneeName: 'Alex',
      estimate: 5,
      createdAt: new Date('2026-01-01T08:00:00.000Z'),
      resolvedAt: new Date('2026-01-09T10:00:00.000Z'),
    });
    expect(n.transitions).toEqual([
      { seq: 0, at: new Date('2026-01-02T10:00:00Z'), fromStatusId: '10000', toStatusId: '3' },
      { seq: 4, at: new Date('2026-01-09T10:00:00Z'), fromStatusId: '3', toStatusId: '10003' },
    ]);
    expect(n.changes).toEqual([
      {
        seq: 1,
        at: new Date('2026-01-02T10:00:00Z'),
        kind: 'flag',
        fromValue: 'on',
        toValue: 'off',
      },
      {
        seq: 2,
        at: new Date('2026-01-04T10:00:00Z'),
        kind: 'estimate',
        fromValue: '3',
        toValue: '5',
      },
      {
        seq: 3,
        at: new Date('2026-01-04T10:00:00Z'),
        kind: 'flag',
        fromValue: 'off',
        toValue: 'on',
      },
    ]);
    expect(n.sprintMembership).toEqual([
      { jiraSprintId: 1, addedAt: new Date('2026-01-02T10:00:00Z'), removedAt: null },
      { jiraSprintId: 2, addedAt: new Date('2026-01-04T10:00:00Z'), removedAt: null },
    ]);
  });

  it('copes with a Data Center user and missing optional fields', () => {
    const n = normalizeIssue(
      {
        ...raw,
        fields: {
          status: { id: '1' },
          assignee: { key: 'JIRAUSER9', name: 'kim', displayName: 'Kim' },
          created: '2026-01-01T00:00:00.000+0000',
          updated: '2026-01-01T00:00:00.000+0000',
        },
      },
      [],
      { estimationFieldId: null, estimationFieldName: null, sprintFieldId: null },
    );
    expect(n).toMatchObject({
      summary: '',
      issueType: 'Issue',
      assigneeId: 'JIRAUSER9',
      estimate: null,
      resolvedAt: null,
      sprintMembership: [],
    });
  });

  it('requests exactly the fields it reads', () => {
    expect(issueFieldList(ctx)).toEqual([
      'summary',
      'issuetype',
      'status',
      'assignee',
      'created',
      'updated',
      'resolutiondate',
      'labels',
      'priority',
      'components',
      'fixVersions',
      'parent',
      'customfield_10016',
      'customfield_10020',
    ]);
  });
});

describe('suggestStatusMapping', () => {
  it('follows Jira status categories and spots waiting states', () => {
    expect(suggestStatusMapping({ id: '1', name: 'Backlog', categoryKey: 'new' })).toEqual({
      category: 'todo',
      blocked: false,
    });
    expect(
      suggestStatusMapping({ id: '2', name: 'In Review', categoryKey: 'indeterminate' }),
    ).toEqual({
      category: 'in_progress',
      blocked: false,
    });
    expect(
      suggestStatusMapping({ id: '3', name: 'Blocked', categoryKey: 'indeterminate' }),
    ).toEqual({
      category: 'in_progress',
      blocked: true,
    });
    expect(
      suggestStatusMapping({ id: '4', name: 'Waiting for customer', categoryKey: 'indeterminate' }),
    ).toMatchObject({ blocked: true });
    expect(suggestStatusMapping({ id: '5', name: 'Closed', categoryKey: 'done' })).toEqual({
      category: 'done',
      blocked: false,
    });
    expect(suggestStatusMapping({ id: '6', name: 'Odd', categoryKey: 'undefined' })).toMatchObject({
      category: 'in_progress',
    });
  });
});

describe('buildIssueJql', () => {
  const now = new Date('2026-10-04T12:00:00Z');
  it('reads the whole board on a first sync', () => {
    expect(buildIssueJql(101, null, now)).toBe('filter = 101 ORDER BY created ASC');
  });
  it('uses relative minutes (time-zone proof) plus a 15-minute overlap', () => {
    expect(buildIssueJql(101, new Date('2026-10-04T11:00:00Z'), now)).toBe(
      'filter = 101 AND updated >= "-75m" ORDER BY created ASC',
    );
    // 59.5 minutes rounds up so nothing slips between syncs
    expect(buildIssueJql(7, new Date('2026-10-04T11:00:30Z'), now)).toBe(
      'filter = 7 AND updated >= "-75m" ORDER BY created ASC',
    );
  });
});

describe('normalizeIssue keys for persistence', () => {
  const histories = () => [
    history('2', '2026-01-15T10:00:00.123+0000', [
      { field: 'Sprint', fieldId: 'customfield_10020', from: '1', to: '1, 2' },
      { field: 'Story Points', fieldId: 'customfield_10016', fromString: '3', toString: '5' },
    ]),
    history('1', '2026-01-02T10:00:00.456+0000', [
      { field: 'Flagged', to: '[10019]' },
      { field: 'status', from: '1', to: '2' },
    ]),
    history('3', '2026-01-16T10:00:00.789+0000', [
      { field: 'Sprint', fieldId: 'customfield_10020', from: '1, 2', to: '2' },
    ]),
  ];

  it('keeps exact change timestamps and one increasing seq across transitions and changes', () => {
    const n = normalizeIssue(raw, histories(), ctx);
    const seqs = [...n.transitions, ...n.changes].map((x) => x.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([0, 1, 2]);
    expect(n.sprintMembership).toEqual([
      {
        jiraSprintId: 1,
        addedAt: new Date('2026-01-01T08:00:00.000Z'),
        removedAt: new Date('2026-01-16T10:00:00.789Z'),
      },
      {
        jiraSprintId: 2,
        addedAt: new Date('2026-01-15T10:00:00.123Z'),
        removedAt: null,
      },
    ]);
  });

  it('gives identical keys and added_at values on every re-sync, whatever the history order', () => {
    const a = normalizeIssue(raw, histories(), ctx);
    const b = normalizeIssue(raw, [...histories()].reverse(), ctx);
    expect(b).toEqual(a);
  });
});

describe('query fields', () => {
  const base = {
    summary: 'S',
    issuetype: { name: 'Story', subtask: false },
    status: { id: '1' },
    created: '2026-10-01T10:00:00.000+0000',
    updated: '2026-10-02T10:00:00.000+0000',
  };
  const raw = (fields: Record<string, unknown>) => ({
    id: '10',
    key: 'A-1',
    fields: { ...base, ...fields },
  });
  const ctx = { estimationFieldId: null, estimationFieldName: null, sprintFieldId: null };

  it('reads labels, components, fix versions and priority, distinct and trimmed', () => {
    const issue = normalizeIssue(
      raw({
        labels: ['ui', ' ui ', 'api', ''],
        components: [{ name: 'Web' }, { name: 'Web' }],
        fixVersions: [{ name: '1.0' }],
        priority: { name: 'High' },
      }),
      [],
      ctx,
    );
    expect(issue).toMatchObject({
      labels: ['ui', 'api'],
      components: ['Web'],
      fixVersions: ['1.0'],
      priority: 'High',
      epicKey: null,
      epicName: null,
    });
  });

  it('takes the epic from the Data Center Epic Link field', () => {
    const issue = normalizeIssue(raw({ customfield_10014: 'EPIC-1' }), [], {
      ...ctx,
      epicLinkFieldId: 'customfield_10014',
    });
    expect(issue).toMatchObject({ epicKey: 'EPIC-1', epicName: null });
  });

  it('takes the epic from a Cloud parent that is an epic, not from other parents', () => {
    const epicParent = raw({
      parent: { key: 'EP-7', fields: { summary: 'Checkout', issuetype: { name: 'Epic' } } },
    });
    expect(normalizeIssue(epicParent, [], ctx)).toMatchObject({
      epicKey: 'EP-7',
      epicName: 'Checkout',
    });
    const levelOne = raw({
      parent: {
        key: 'EP-8',
        fields: { summary: 'Feature', issuetype: { name: 'Feature', hierarchyLevel: 1 } },
      },
    });
    expect(normalizeIssue(levelOne, [], ctx)).toMatchObject({
      epicKey: 'EP-8',
      epicName: 'Feature',
    });
    const storyParent = raw({
      parent: {
        key: 'ST-1',
        fields: { summary: 'Story', issuetype: { name: 'Story', hierarchyLevel: 0 } },
      },
    });
    expect(normalizeIssue(storyParent, [], ctx)).toMatchObject({ epicKey: null, epicName: null });
  });

  it('never fails on malformed values', () => {
    const issue = normalizeIssue(
      raw({ labels: 'ui', components: [{ id: 1 }], priority: 'High', parent: 42 }),
      [],
      { ...ctx, epicLinkFieldId: 'customfield_10014' },
    );
    expect(issue).toMatchObject({
      labels: [],
      components: [],
      fixVersions: [],
      priority: null,
      epicKey: null,
    });
  });

  it('finds the Epic Link field and requests the new fields', () => {
    expect(
      findEpicLinkField([
        {
          id: 'customfield_10014',
          name: 'Epic Link',
          custom: 'com.pyxis.greenhopper.jira:gh-epic-link',
        },
      ] as never),
    ).toBe('customfield_10014');
    expect(findEpicLinkField([])).toBeNull();
    expect(issueFieldList({ ...ctx, epicLinkFieldId: 'customfield_10014' })).toEqual(
      expect.arrayContaining([
        'labels',
        'priority',
        'components',
        'fixVersions',
        'parent',
        'customfield_10014',
      ]),
    );
  });
});
