import type { BoardDataset, MetricSprint } from '@agile/metrics';
import { d, issue } from '@agile/metrics/testing';

// Five issues and three sprints; every expected value in the query tests is derived from here.
// T0 (day 0) is Monday 2026-01-05. NOW is day 30 (Wednesday 2026-02-04).
export const NOW = d(30);

const sprint = (
  id: string,
  name: string,
  state: MetricSprint['state'],
  start: number,
  end: number,
  complete: number | null,
  members: string[],
): MetricSprint => ({
  id,
  name,
  state,
  startAt: d(start),
  endAt: d(end),
  completeAt: complete === null ? null : d(complete),
  members: members.map((issueId) => ({ issueId, addedAt: d(start - 1), removedAt: null })),
});

export const S1 = sprint('s1', 'Sprint 1', 'closed', 0, 10, 10, ['A']);
export const S2 = sprint('s2', 'Sprint 2', 'closed', 14, 24, 24, ['B', 'C']);
export const S3 = sprint('s3', 'Sprint 3', 'active', 28, 42, null, ['C', 'D']);

/**
 * A  Bug    Done         pat  3 pts  ui      Web  E-1 Checkout  High    created d-2, in progress d1, done d4   S1
 * B  Bug    Done         sam  5 pts  ui,api  —    E-2 Platform  High    created d2, in progress d15, done d20  S2  fix 1.0
 * C  Story  In Progress  pat  8 pts  —       —    E-1 Checkout  Medium  created d5, in progress d16            S2, S3
 * D  Story  To Do        —    2 pts  api     —    —             Low     created d25                           S3
 * E  Bug    To Do        —    —      —       —    —             Medium  created d29                           —
 */
export function queryDataset(): BoardDataset {
  return {
    hasEstimates: true,
    fieldsSynced: true,
    sprints: [S1, S2, S3],
    issues: [
      issue('A', {
        type: 'Bug',
        status: 'Done',
        created: d(-2),
        estimate: 3,
        assignee: 'pat',
        labels: ['ui'],
        components: ['Web'],
        fixVersions: [],
        epicKey: 'E-1',
        epicName: 'Checkout',
        priority: 'High',
        steps: [
          [d(1), 'in_progress'],
          [d(4), 'done'],
        ],
      }),
      issue('B', {
        type: 'Bug',
        status: 'Done',
        created: d(2),
        estimate: 5,
        assignee: 'sam',
        labels: ['ui', 'api'],
        components: [],
        fixVersions: ['1.0'],
        epicKey: 'E-2',
        epicName: 'Platform',
        priority: 'High',
        steps: [
          [d(15), 'in_progress'],
          [d(20), 'done'],
        ],
      }),
      issue('C', {
        type: 'Story',
        status: 'In Progress',
        created: d(5),
        estimate: 8,
        assignee: 'pat',
        labels: [],
        components: [],
        fixVersions: [],
        epicKey: 'E-1',
        epicName: 'Checkout',
        priority: 'Medium',
        steps: [[d(16), 'in_progress']],
      }),
      issue('D', {
        type: 'Story',
        status: 'To Do',
        created: d(25),
        estimate: 2,
        assignee: null,
        labels: ['api'],
        components: [],
        fixVersions: [],
        epicKey: null,
        epicName: null,
        priority: 'Low',
      }),
      issue('E', {
        type: 'Bug',
        status: 'To Do',
        created: d(29),
        estimate: null,
        assignee: null,
        labels: [],
        components: [],
        fixVersions: [],
        epicKey: null,
        epicName: null,
        priority: 'Medium',
      }),
    ],
  };
}
