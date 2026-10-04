import { parseSkillDocument, type SkillDocument, serializeSkill } from './document';

/**
 * The built-in library (spec: "Built-in library"). Written by us, so trusted; every workspace
 * member can load them on demand, and "Use" copies one into an editable skill of their own.
 * Instructions are in English; the model answers in the user's language.
 */
const LIBRARY = [
  {
    name: 'sprint-health-check',
    description: 'Is the current sprint on track? Scope, progress, risks and what to do next.',
    instructions: `Assess the health of the current sprint of each board in scope (or the board the user names).

1. Call list_boards, then for each Scrum board: get_metric sprint_burndown (sprint: current), scope_change (sprint: current), say_do_ratio and average_velocity.
2. Compare remaining work with the days left and the ideal line; flag scope added after the start.
3. Call find_issues with sprint: current, status: in_progress, sort: age to spot items that have been in progress for long, and flagged: true for blocked items.
4. Answer with: a one-line verdict (on track / at risk / off track), three to five evidence bullets with numbers, and at most three recommended actions.`,
  },
  {
    name: 'daily-standup-brief',
    description:
      'A short brief for the daily stand-up: what moved, what is stuck, what needs a decision.',
    instructions: `Prepare a stand-up brief for the boards in scope.

1. Call find_issues with sort: updated to see what changed recently, and with flagged: true for blocked items.
2. Call get_metric aging_wip to find in-progress items older than usual.
3. Write three short sections: "Moved since yesterday", "Stuck or blocked", "Needs a decision". Keep it under 150 words, issue keys first.`,
  },
  {
    name: 'retro-prep',
    description:
      'Facts for the retrospective of the last closed sprint: commitment, scope change, carry-over, flow.',
    instructions: `Prepare facts for the retrospective of the last closed sprint.

1. Call get_metric velocity, say_do_ratio, scope_change (sprint: last_closed) and carry_over.
2. Call get_metric cycle_time and flow_efficiency for the sprint period.
3. Present "What went well" and "What to look at" with numbers, then three open questions for the team. Do not blame individuals.`,
  },
  {
    name: 'stale-work-detector',
    description: 'Finds stale and aging work items that need attention.',
    instructions: `Find work that is stale or aging on the boards in scope.

1. Call get_metric hygiene (staleDays: 14) and get_metric aging_wip.
2. Call find_issues with status: in_progress and staleDays: 7.
3. List the items that need attention, oldest first, with key, age in days and the reason (stale, older than usual, blocked). Suggest one next step per item.`,
  },
  {
    name: 'scope-creep-watcher',
    description: 'Watches work added to the current sprint after it started.',
    instructions: `Check whether the current sprint's scope grew after it started.

1. Call get_metric scope_change (sprint: current) and sprint_burnup (sprint: current).
2. If work was added, call find_issues with sprint: current, sort: updated to name the added items when possible.
3. Report the amount added and removed, its share of the initial commitment, and whether the sprint goal is at risk.`,
  },
  {
    name: 'delivery-forecast',
    description:
      'Monte Carlo forecast: how much will be done by a date, or when a number of items will be done.',
    instructions: `Forecast delivery from recent throughput.

1. Use forecast with question: how_many (days the user gives, default 14) and question: when (items the user gives, default 10).
2. Report the 50/85/95% answers and recommend planning on the 85% line. Say how many days of history were used and that it assumes the recent pace continues.`,
  },
  {
    name: 'blocker-report',
    description: 'Lists blocked and flagged work and how long it has been blocked.',
    instructions: `Report blocked work on the boards in scope.

1. Call find_issues with flagged: true, then with status: in_progress and sort: age.
2. Call get_metric aging_wip for the blocked/late codes and flow_efficiency for the time lost waiting.
3. List each blocker with key, summary, days in progress and the likely impact. End with the single most important blocker to remove.`,
  },
  {
    name: 'kanban-flow-review',
    description: 'Flow review for Kanban boards: throughput, cycle time, WIP and aging work.',
    instructions: `Review flow on the Kanban boards in scope.

1. Call get_metric throughput (weeks: 8), throughput_rate, cycle_time, wip, wip_trend and cfd.
2. Look for rising WIP with flat throughput (a sign of overload) and for a widening cycle time.
3. Give the four key numbers, the trend in one sentence each, and at most three improvement experiments.`,
  },
  {
    name: 'team-workload-balance',
    description: 'How in-progress work is spread across assignees, and where it is unassigned.',
    instructions: `Check how work in progress is spread.

1. Call find_issues with status: in_progress and limit: 50, then group the result by assignee yourself.
2. Call get_metric hygiene to find unassigned in-progress items.
3. Show counts per assignee as a short table, highlight overload (more than 3 in progress) and unassigned work. Follow the workspace's preferences about naming people.`,
  },
] as const;

export type BuiltinSkillKey = (typeof LIBRARY)[number]['name'];

export interface BuiltinSkill {
  key: BuiltinSkillKey;
  document: string;
  skill: SkillDocument;
}

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = Object.freeze(
  LIBRARY.map((s) => {
    const document = serializeSkill({
      frontmatter: {
        name: s.name,
        description: s.description,
        trigger: 'on_demand',
        output: 'chat',
      },
      instructions: s.instructions,
    });
    const parsed = parseSkillDocument(document);
    if (!parsed.ok) throw new Error(`Built-in skill ${s.name} is invalid`);
    return { key: s.name, document, skill: parsed.skill };
  }),
);

export const builtinSkill = (key: string): BuiltinSkill | undefined =>
  BUILTIN_SKILLS.find((s) => s.key === key);
