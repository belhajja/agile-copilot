// Deterministic demo data served by the mock Jira (e2e and local review). Every date is relative to
// `anchor` (00:00 UTC of the day the mock starts), so the dashboards always look current.
//
// "DEMO Scrum" (board 1, filter 101, story points): sprints 1–3 closed, sprint 4 active.
//   Each closed sprint commits 20 pts (an issue carried in + 5 new: 5,3,3,3,3), finishes 19
//   (one 3-pt issue carried out, one 2-pt bug added and done) → average velocity 19, say/do 95%,
//   1 issue carried over from the last sprint, 2 pts added to the active sprint.
// "OPS Kanban" (board 2, filter 102, no estimates): 24 done issues with cycle times 1,2,3,4,5,8
//   days (×4) → cycle time p85 = 8 days; 12 finished in the last 28 days → 3 per week; the four
//   8-day issues spent 4 days Blocked → flow efficiency (92 − 16) / 92 = 83%; 4 in progress now.

export interface MockChangelogItem {
  field: string;
  fieldId?: string;
  fieldtype: string;
  from: string | null;
  fromString: string | null;
  to: string | null;
  toString: string | null;
}

export interface MockIssue {
  id: string;
  key: string;
  filterIds: number[];
  fields: Record<string, unknown>;
  histories: { id: string; created: string; items: MockChangelogItem[] }[];
}

export interface MockBoard {
  id: number;
  name: string;
  /** `simple` = team-managed: sprints only when the project enabled them (else Jira answers 400). */
  type: 'scrum' | 'kanban' | 'simple';
  projectKey: string;
  filterId: number;
  estimation: { fieldId: string; displayName: string } | null;
  columns: { name: string; statusIds: string[] }[];
}

export interface MockSprint {
  id: number;
  boardId: number;
  name: string;
  state: 'future' | 'active' | 'closed';
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  goal?: string;
}

export interface MockWorklog {
  id: string;
  author: { accountId: string; name: string; displayName: string };
  started: string;
  timeSpentSeconds: number;
  comment?: string;
}

export interface MockComment {
  id: string;
  author: { accountId: string; name: string; displayName: string };
  body: string;
  created: string;
}

export interface MockJiraDataset {
  boards: MockBoard[];
  statuses: { id: string; name: string; categoryKey: 'new' | 'indeterminate' | 'done' }[];
  fields: { id: string; name: string; custom: boolean; schemaCustom?: string }[];
  sprints: MockSprint[];
  issues: MockIssue[];
  worklogs?: Record<string, MockWorklog[]>;
  comments?: Record<string, MockComment[]>;
  versions?: Record<
    string,
    {
      id: string;
      name: string;
      released: boolean;
      archived: boolean;
      releaseDate?: string;
      description?: string;
    }[]
  >;
  components?: Record<
    string,
    { id: string; name: string; description?: string; lead?: { displayName: string } }[]
  >;
  linkTypes?: { id: string; name: string; inward: string; outward: string }[];
  watchers?: Record<
    string,
    { displayName: string; name: string; accountId: string; emailAddress?: string }[]
  >;
  /** null = time tracking disabled. */
  timeTracking?: { workingHoursPerDay: number; workingDaysPerWeek: number } | null;
}

export const DEMO_STORY_POINTS = 'customfield_10016';
export const DEMO_SPRINT_FIELD = 'customfield_10020';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const STATUS = { todo: '10000', progress: '3', review: '10001', blocked: '10002', done: '10003' };
const STATUS_NAME: Record<string, string> = {
  [STATUS.todo]: 'To Do',
  [STATUS.progress]: 'In Progress',
  [STATUS.review]: 'In Review',
  [STATUS.blocked]: 'Blocked',
  [STATUS.done]: 'Done',
};
const PEOPLE = [
  { accountId: 'u-alex', key: 'alex', name: 'alex', displayName: 'Alex Martin' },
  { accountId: 'u-sam', key: 'sam', name: 'sam', displayName: 'Sam Leroy' },
  { accountId: 'u-kim', key: 'kim', name: 'kim', displayName: 'Kim Dubois' },
];

/** Jira's timestamp format, e.g. 2026-10-03T10:00:00.000+0000. */
export const jiraTime = (d: Date) => d.toISOString().replace('Z', '+0000');

interface IssueSpec {
  project: 'DEMO' | 'OPS';
  type: 'Story' | 'Bug' | 'Task';
  summary: string;
  created: Date;
  estimate?: number;
  assignee?: (typeof PEOPLE)[number] | null;
  /** Sprint field changes; the issue's sprints at creation are `initialSprints`. */
  initialSprints?: number[];
  sprintChanges?: { at: Date; to: number[] }[];
  /** Status changes after creation (the issue starts in To Do). */
  path?: [at: Date, statusId: string][];
}

export function demoDataset(anchor: Date): MockJiraDataset {
  const base = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  const at = (day: number, hour = 12, minute = 0) =>
    new Date(base + day * DAY + hour * HOUR + minute * 60_000);

  const sprints: MockSprint[] = [1, 2, 3, 4].map((k) => {
    const s = -49 + 14 * (k - 1);
    return {
      id: k,
      boardId: 1,
      name: `DEMO Sprint ${k}`,
      state: k <= 3 ? 'closed' : 'active',
      startDate: jiraTime(at(s, 10)),
      endDate: jiraTime(at(s + 14, 9)),
      ...(k <= 3 ? { completeDate: jiraTime(at(s + 14, 9)) } : {}),
      goal: `Sprint ${k} goal`,
    };
  });
  const sprintName = (id: number) => sprints.find((s) => s.id === id)?.name ?? `Sprint ${id}`;

  const counters = { DEMO: 0, OPS: 0 };
  let nextIssueId = 10_000;
  let nextHistoryId = 50_000;
  const issues: MockIssue[] = [];

  function add(spec: IssueSpec) {
    counters[spec.project]++;
    const histories: MockIssue['histories'] = [];
    const events: { at: Date; item: MockChangelogItem }[] = [];
    let sprintsNow = spec.initialSprints ?? [];
    for (const change of spec.sprintChanges ?? []) {
      events.push({
        at: change.at,
        item: {
          field: 'Sprint',
          fieldId: DEMO_SPRINT_FIELD,
          fieldtype: 'custom',
          from: sprintsNow.length ? sprintsNow.join(', ') : null,
          fromString: sprintsNow.length ? sprintsNow.map(sprintName).join(', ') : null,
          to: change.to.join(', '),
          toString: change.to.map(sprintName).join(', '),
        },
      });
      sprintsNow = change.to;
    }
    let status = STATUS.todo;
    for (const [when, to] of spec.path ?? []) {
      events.push({
        at: when,
        item: {
          field: 'status',
          fieldId: 'status',
          fieldtype: 'jira',
          from: status,
          fromString: STATUS_NAME[status] ?? null,
          to,
          toString: STATUS_NAME[to] ?? null,
        },
      });
      status = to;
    }
    events.sort((a, b) => a.at.getTime() - b.at.getTime());
    for (const e of events) {
      histories.push({ id: String(nextHistoryId++), created: jiraTime(e.at), items: [e.item] });
    }
    const last = events.at(-1)?.at ?? spec.created;
    const doneAt = status === STATUS.done ? last : null;
    issues.push({
      id: String(nextIssueId++),
      key: `${spec.project}-${counters[spec.project]}`,
      filterIds: [spec.project === 'DEMO' ? 101 : 102],
      fields: {
        summary: spec.summary,
        issuetype: { name: spec.type, subtask: false },
        status: { id: status, name: STATUS_NAME[status] },
        assignee: spec.assignee ?? null,
        created: jiraTime(spec.created),
        updated: jiraTime(last),
        resolutiondate: doneAt ? jiraTime(doneAt) : null,
        [DEMO_STORY_POINTS]: spec.estimate ?? null,
        [DEMO_SPRINT_FIELD]: sprintsNow.length
          ? sprintsNow.map((id) => ({
              id,
              name: sprintName(id),
              state: sprints.find((s) => s.id === id)?.state,
              boardId: 1,
            }))
          : null,
      },
      histories,
    });
  }

  // ---- DEMO Scrum ----
  const start = (k: number) => -49 + 14 * (k - 1);
  const s1 = start(1);
  add({
    project: 'DEMO',
    type: 'Story',
    summary: 'Set up the release pipeline',
    created: at(s1 - 2, 10),
    estimate: 3,
    assignee: PEOPLE[0],
    sprintChanges: [{ at: at(s1 - 1, 10), to: [1] }],
    path: [
      [at(s1 + 1, 10), STATUS.progress],
      [at(s1 + 3, 10), STATUS.review],
      [at(s1 + 3, 16), STATUS.done],
    ],
  });
  for (let k = 1; k <= 4; k++) {
    const s = start(k);
    [5, 3, 3, 3, 3].forEach((points, j) => {
      const common = {
        project: 'DEMO' as const,
        type: 'Story' as const,
        summary: `Sprint ${k} story ${j + 1}`,
        created: at(s - 2, 10),
        estimate: points,
        assignee: PEOPLE[j % PEOPLE.length],
      };
      const joined = { at: at(s - 1, 10), to: [k] };
      if (k <= 3 && j < 4) {
        add({
          ...common,
          sprintChanges: [joined],
          path: [
            [at(s + j + 1, 10), STATUS.progress],
            [at(s + j + 2, 10), STATUS.review],
            [at(s + j + 2, 15), STATUS.done],
          ],
        });
      } else if (k <= 3) {
        // Carried over: still in progress when sprint k closes, finished in sprint k + 1.
        const next = start(k + 1);
        add({
          ...common,
          sprintChanges: [joined, { at: at(next, 9, 1), to: [k, k + 1] }],
          path: [
            [at(s + 5, 10), STATUS.progress],
            [at(next + 3, 10), STATUS.review],
            [at(next + 3, 16), STATUS.done],
          ],
        });
      } else {
        // Active sprint 4: two done, one in progress (unassigned), two not started.
        const path: [Date, string][] =
          j === 0
            ? [
                [at(s + 1, 10), STATUS.progress],
                [at(s + 3, 15), STATUS.done],
              ]
            : j === 1
              ? [
                  [at(s + 2, 10), STATUS.progress],
                  [at(s + 4, 15), STATUS.done],
                ]
              : j === 2
                ? [[at(s + 4, 10), STATUS.progress]]
                : [];
        add({
          ...common,
          assignee: j === 2 ? null : common.assignee,
          sprintChanges: [joined],
          path,
        });
      }
    });
    // Added after the sprint started.
    add({
      project: 'DEMO',
      type: 'Bug',
      summary: `Sprint ${k} production bug`,
      created: at(s + 3, 11),
      estimate: 2,
      assignee: PEOPLE[1],
      initialSprints: [k],
      path:
        k <= 3
          ? [
              [at(s + 4, 10), STATUS.progress],
              [at(s + 6, 15), STATUS.done],
            ]
          : [],
    });
  }

  // ---- OPS Kanban ----
  const cycles = [1, 2, 3, 4, 5, 8];
  for (let i = 0; i < 24; i++) {
    const doneDay = i < 12 ? -(1 + 2 * i) : -(30 + 2 * (i - 12));
    const done = at(doneDay, 12);
    const ct = cycles[i % cycles.length] ?? 1;
    const started = new Date(done.getTime() - ct * DAY);
    const path: [Date, string][] =
      ct === 8
        ? [
            [started, STATUS.progress],
            [new Date(started.getTime() + 2 * DAY), STATUS.blocked],
            [new Date(started.getTime() + 6 * DAY), STATUS.progress],
            [done, STATUS.done],
          ]
        : [
            [started, STATUS.progress],
            [done, STATUS.done],
          ];
    add({
      project: 'OPS',
      type: 'Task',
      summary: `Ops request ${i + 1}`,
      created: new Date(started.getTime() - 2 * DAY),
      assignee: PEOPLE[i % PEOPLE.length],
      path,
    });
  }
  const inProgress: [startDay: number, blockedDay?: number][] = [[-3], [-6], [-10, -8], [-1]];
  inProgress.forEach(([startDay, blockedDay], n) => {
    const path: [Date, string][] = [[at(startDay, 10), STATUS.progress]];
    if (blockedDay !== undefined) path.push([at(blockedDay, 10), STATUS.blocked]);
    add({
      project: 'OPS',
      type: 'Task',
      summary: `Ops work in progress ${n + 1}`,
      created: at(startDay - 2, 10),
      assignee: PEOPLE[n % PEOPLE.length],
      path,
    });
  });
  for (let n = 0; n < 3; n++) {
    add({
      project: 'OPS',
      type: 'Task',
      summary: `Ops backlog item ${n + 1}`,
      created: at(-2, 9),
      assignee: null,
    });
  }

  const demo1 = issues.find((i) => i.key === 'DEMO-1');
  const demo2 = issues.find((i) => i.key === 'DEMO-2');
  if (demo1) {
    demo1.fields.timetracking = {
      originalEstimate: '1d 3h 12m',
      remainingEstimate: '0m',
      timeSpent: '1d 6h',
      originalEstimateSeconds: 40320,
      remainingEstimateSeconds: 0,
      timeSpentSeconds: 50400,
    };
  }
  if (demo2) {
    demo2.fields.timetracking = {
      originalEstimate: '4d',
      remainingEstimate: '3d 4h',
      timeSpent: '4h',
      originalEstimateSeconds: 115200,
      remainingEstimateSeconds: 100800,
      timeSpentSeconds: 14400,
    };
  }
  const person = (p: { accountId: string; name: string; displayName: string }) => ({
    accountId: p.accountId,
    name: p.name,
    displayName: p.displayName,
  });
  const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

  return {
    boards: [
      {
        id: 1,
        name: 'DEMO Scrum',
        type: 'scrum',
        projectKey: 'DEMO',
        filterId: 101,
        estimation: { fieldId: DEMO_STORY_POINTS, displayName: 'Story Points' },
        columns: [
          { name: 'To Do', statusIds: [STATUS.todo] },
          { name: 'In Progress', statusIds: [STATUS.progress, STATUS.blocked] },
          { name: 'In Review', statusIds: [STATUS.review] },
          { name: 'Done', statusIds: [STATUS.done] },
        ],
      },
      {
        id: 2,
        name: 'OPS Kanban',
        type: 'kanban',
        projectKey: 'OPS',
        filterId: 102,
        estimation: null,
        columns: [
          { name: 'Backlog', statusIds: [STATUS.todo] },
          { name: 'In Progress', statusIds: [STATUS.progress] },
          { name: 'Blocked', statusIds: [STATUS.blocked] },
          { name: 'Done', statusIds: [STATUS.done] },
        ],
      },
    ],
    statuses: [
      { id: STATUS.todo, name: 'To Do', categoryKey: 'new' },
      { id: STATUS.progress, name: 'In Progress', categoryKey: 'indeterminate' },
      { id: STATUS.review, name: 'In Review', categoryKey: 'indeterminate' },
      { id: STATUS.blocked, name: 'Blocked', categoryKey: 'indeterminate' },
      { id: STATUS.done, name: 'Done', categoryKey: 'done' },
    ],
    fields: [
      { id: 'summary', name: 'Summary', custom: false },
      { id: 'status', name: 'Status', custom: false },
      {
        id: DEMO_STORY_POINTS,
        name: 'Story Points',
        custom: true,
        schemaCustom: 'com.atlassian.jira.plugin.system.customfieldtypes:float',
      },
      {
        id: DEMO_SPRINT_FIELD,
        name: 'Sprint',
        custom: true,
        schemaCustom: 'com.pyxis.greenhopper.jira:gh-sprint',
      },
    ],
    sprints,
    issues,
    worklogs: {
      'DEMO-1': [
        {
          id: '100001',
          author: person(PEOPLE[0]!),
          started: jiraTime(at(-5, 9)),
          timeSpentSeconds: 7200,
          comment: 'Pipeline <b>fix</b>',
        },
        {
          id: '100002',
          author: person(PEOPLE[1]!),
          started: jiraTime(at(-3, 14)),
          timeSpentSeconds: 3600,
        },
      ],
      'DEMO-2': [
        {
          id: '100003',
          author: person(PEOPLE[2]!),
          started: jiraTime(at(-4, 10)),
          timeSpentSeconds: 14400,
        },
      ],
    },
    comments: {
      'DEMO-1': [
        {
          id: '90001',
          author: person(PEOPLE[0]!),
          body: 'Looks blocked on the API team.',
          created: jiraTime(at(-5, 9, 30)),
        },
      ],
    },
    versions: {
      DEMO: [
        {
          id: '10000',
          name: '1.0',
          released: true,
          archived: false,
          releaseDate: dateOnly(at(-10)),
        },
        { id: '10001', name: '1.1', released: false, archived: false },
      ],
    },
    components: {
      DEMO: [{ id: '20000', name: 'API', lead: { displayName: PEOPLE[2]!.displayName } }],
    },
    linkTypes: [{ id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }],
    watchers: {
      'DEMO-1': [
        {
          ...person(PEOPLE[0]!),
          emailAddress: 'alex.martin@example.com',
        },
      ],
    },
    timeTracking: { workingHoursPerDay: 8, workingDaysPerWeek: 5 },
  };
}
