// Hand-built datasets for the golden tests. Every expected number in the tests is derived in the
// comments next to it from these definitions.
import type { EstimateChange, Interval, MetricIssue, MetricSprint, StatusCategory } from './model';
import { DAY, HOUR } from './time';

/** Monday 2026-01-05 00:00 UTC. */
export const T0 = Date.UTC(2026, 0, 5);
export const d = (day: number, hour = 0): Date => new Date(T0 + day * DAY + hour * HOUR);

type Step = [at: Date, category: StatusCategory, blocked?: boolean];

export function issue(
  key: string,
  opts: {
    created: Date;
    steps?: Step[];
    estimate?: number | null;
    estimateChanges?: EstimateChange[];
    flagged?: Interval[];
    assignee?: string | null;
    updated?: Date;
    type?: string;
    status?: string;
    labels?: string[];
    components?: string[];
    fixVersions?: string[];
    priority?: string | null;
    epicKey?: string | null;
    epicName?: string | null;
  },
): MetricIssue {
  return {
    id: key,
    key,
    summary: `Summary of ${key}`,
    type: opts.type ?? 'Story',
    createdAt: opts.created,
    updatedAt: opts.updated ?? opts.created,
    assignee: opts.assignee === undefined ? 'pat' : opts.assignee,
    estimate: opts.estimate ?? null,
    estimateChanges: opts.estimateChanges ?? [],
    statusPeriods: [
      { from: opts.created, category: 'todo', blocked: false },
      ...(opts.steps ?? []).map(([from, category, blocked]) => ({
        from,
        category,
        blocked: blocked ?? false,
      })),
    ],
    flagged: opts.flagged ?? [],
    status: opts.status,
    labels: opts.labels,
    components: opts.components,
    fixVersions: opts.fixVersions,
    priority: opts.priority,
    epicKey: opts.epicKey,
    epicName: opts.epicName,
  };
}

/**
 * One closed sprint, day 0 09:00 → day 10 09:00 (closed on time).
 * A 5 pts  committed, in progress d1, done d3
 * B 3 pts  committed (estimated 2 until d5), in progress d2, done d8
 * C 8 pts  committed, in progress d4, never done            → carried over
 * D 2 pts  committed, removed from the sprint d5            → scope removed
 * E 1 pt   created and added d4 12:00, in progress d5, done d6 → scope added
 */
export function scrumFixture() {
  const added = (id: string, at: Date, removedAt: Date | null = null) => ({
    issueId: id,
    addedAt: at,
    removedAt,
  });
  const issues = [
    issue('A', {
      created: d(-3),
      estimate: 5,
      steps: [
        [d(1), 'in_progress'],
        [d(3), 'done'],
      ],
    }),
    issue('B', {
      created: d(-3),
      estimate: 3,
      estimateChanges: [{ at: d(5), from: 2, to: 3 }],
      steps: [
        [d(2), 'in_progress'],
        [d(8), 'done'],
      ],
    }),
    issue('C', { created: d(-3), estimate: 8, steps: [[d(4), 'in_progress']] }),
    issue('D', { created: d(-3), estimate: 2 }),
    issue('E', {
      created: d(4, 12),
      estimate: 1,
      steps: [
        [d(5), 'in_progress'],
        [d(6), 'done'],
      ],
    }),
  ];
  const sprint: MetricSprint = {
    id: 's1',
    name: 'Sprint 1',
    state: 'closed',
    startAt: d(0, 9),
    endAt: d(10, 9),
    completeAt: d(10, 9),
    members: [
      added('A', d(-1)),
      added('B', d(-1)),
      added('C', d(-1)),
      added('D', d(-1), d(5)),
      added('E', d(4, 12)),
    ],
  };
  return { issues, sprints: [sprint], hasEstimates: true };
}

/**
 * Kanban board, observed at now = d30 (Wednesday 2026-02-04).
 * K1 created d0, in progress d2, done d4                       cycle 2, lead 4
 * K2 created d1, in progress d3, Blocked d5, in progress d7,
 *    flagged d8→d9, done d11                                   cycle 8, lead 10, blocked 3
 * K3 created d2, done d6 straight from to-do                   no cycle time, lead 4
 * K4 created d5, in progress d6, done d26                      cycle 20, lead 21
 * K5 created d10, in progress d20, last updated d10, 21 pts    in progress (stale, oversized)
 * K6 created d12, in progress d28, unassigned, 3 pts           in progress
 * K7 created d29, unestimated                                  to do
 */
export function flowFixture() {
  const issues = [
    issue('K1', {
      created: d(0),
      estimate: 1,
      steps: [
        [d(2), 'in_progress'],
        [d(4), 'done'],
      ],
    }),
    issue('K2', {
      created: d(1),
      estimate: 3,
      flagged: [{ from: d(8), to: d(9) }],
      steps: [
        [d(3), 'in_progress'],
        [d(5), 'in_progress', true],
        [d(7), 'in_progress'],
        [d(11), 'done'],
      ],
    }),
    issue('K3', { created: d(2), estimate: 1, steps: [[d(6), 'done']] }),
    issue('K4', {
      created: d(5),
      estimate: 5,
      steps: [
        [d(6), 'in_progress'],
        [d(26), 'done'],
      ],
    }),
    issue('K5', {
      created: d(10),
      estimate: 21,
      updated: d(10),
      steps: [[d(20), 'in_progress']],
    }),
    issue('K6', {
      created: d(12),
      estimate: 3,
      assignee: null,
      updated: d(28),
      steps: [[d(28), 'in_progress']],
    }),
    issue('K7', { created: d(29), updated: d(29) }),
  ];
  return { issues, sprints: [], hasEstimates: true };
}
