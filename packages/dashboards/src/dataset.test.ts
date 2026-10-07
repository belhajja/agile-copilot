import { describe, expect, it } from 'vitest';
import { type StatusMapping, toMetricIssue } from './dataset';

const t = (iso: string) => new Date(iso);
const issue = {
  id: 'i1',
  orgId: 'o',
  connectionId: 'c',
  jiraIssueId: '1',
  key: 'A-1',
  summary: 'S',
  issueType: 'Story',
  isSubtask: false,
  statusId: '4',
  assigneeId: 'u-1',
  assigneeName: null,
  estimate: 5,
  jiraCreatedAt: t('2026-01-01T00:00:00Z'),
  jiraUpdatedAt: t('2026-01-09T00:00:00Z'),
  resolvedAt: null,
  syncedAt: t('2026-01-10T00:00:00Z'),
  labels: [],
  components: [],
  fixVersions: [],
  priority: null,
  epicKey: null,
  epicName: null,
};
const mappings = new Map<string, StatusMapping>([
  ['1', { category: 'todo', blocked: false }],
  ['2', { category: 'in_progress', blocked: false }],
  ['3', { category: 'in_progress', blocked: true }],
  ['4', { category: 'done', blocked: false }],
]);

describe('toMetricIssue', () => {
  it('builds status periods from transitions, merging statuses with the same mapping', () => {
    const m = toMetricIssue(
      issue,
      [
        { at: t('2026-01-02T00:00:00Z'), fromStatusId: '1', toStatusId: '2' },
        { at: t('2026-01-03T00:00:00Z'), fromStatusId: '2', toStatusId: '9' }, // unmapped → to-do
        { at: t('2026-01-04T00:00:00Z'), fromStatusId: '9', toStatusId: '3' },
        { at: t('2026-01-05T00:00:00Z'), fromStatusId: '3', toStatusId: '2' },
        { at: t('2026-01-06T00:00:00Z'), fromStatusId: '2', toStatusId: '2' }, // no-op move
        { at: t('2026-01-07T00:00:00Z'), fromStatusId: '2', toStatusId: '4' },
      ],
      [],
      mappings,
    );
    expect(m.statusPeriods).toEqual([
      { from: t('2026-01-01T00:00:00Z'), category: 'todo', blocked: false },
      { from: t('2026-01-02T00:00:00Z'), category: 'in_progress', blocked: false },
      { from: t('2026-01-03T00:00:00Z'), category: 'todo', blocked: false },
      { from: t('2026-01-04T00:00:00Z'), category: 'in_progress', blocked: true },
      { from: t('2026-01-05T00:00:00Z'), category: 'in_progress', blocked: false },
      { from: t('2026-01-07T00:00:00Z'), category: 'done', blocked: false },
    ]);
    expect(m.assignee).toBe('u-1');
  });

  it('never leaves two adjacent periods with the same category', () => {
    const m = toMetricIssue(
      issue,
      [
        { at: t('2026-01-02T00:00:00Z'), fromStatusId: '1', toStatusId: '2' },
        { at: t('2026-01-02T00:00:00Z'), fromStatusId: '2', toStatusId: '1' },
      ],
      [],
      mappings,
    );
    expect(m.statusPeriods).toEqual([
      { from: t('2026-01-01T00:00:00Z'), category: 'todo', blocked: false },
    ]);
  });

  it('uses the current status when the issue never moved', () => {
    expect(toMetricIssue({ ...issue, statusId: '2' }, [], [], mappings).statusPeriods).toEqual([
      { from: t('2026-01-01T00:00:00Z'), category: 'in_progress', blocked: false },
    ]);
  });

  it('turns flag and estimate changes into intervals and estimate history', () => {
    const m = toMetricIssue(
      issue,
      [],
      [
        { at: t('2026-01-02T00:00:00Z'), kind: 'flag', fromValue: 'on', toValue: 'off' },
        { at: t('2026-01-03T00:00:00Z'), kind: 'estimate', fromValue: '3', toValue: '5' },
        { at: t('2026-01-04T00:00:00Z'), kind: 'flag', fromValue: 'off', toValue: 'on' },
      ],
      mappings,
    );
    expect(m.flagged).toEqual([
      { from: t('2026-01-01T00:00:00Z'), to: t('2026-01-02T00:00:00Z') },
      { from: t('2026-01-04T00:00:00Z'), to: null },
    ]);
    expect(m.estimateChanges).toEqual([{ at: t('2026-01-03T00:00:00Z'), from: 3, to: 5 }]);
  });

  it('carries the query fields and the current status name', () => {
    const m = toMetricIssue(
      { ...issue, labels: ['ui'], components: ['Web'], fixVersions: ['1.0'], priority: 'High', epicKey: 'E-1', epicName: 'Checkout' },
      [],
      [],
      new Map<string, StatusMapping>([['4', { category: 'done', blocked: false, name: 'Done' }]]),
    );
    expect(m).toMatchObject({
      status: 'Done',
      labels: ['ui'],
      components: ['Web'],
      fixVersions: ['1.0'],
      priority: 'High',
      epicKey: 'E-1',
      epicName: 'Checkout',
    });
  });
});
