import {
  type Db,
  jiraBoardIssues,
  jiraBoardSprints,
  jiraBoards,
  jiraIssueChanges,
  jiraIssues,
  jiraIssueTransitions,
  jiraSprintIssues,
  jiraSprints,
  jiraStatusMappings,
  withOrg,
} from '@agile/db';
import type {
  BoardDataset,
  Interval,
  MetricIssue,
  MetricSprint,
  StatusCategory,
  StatusPeriod,
} from '@agile/metrics';
import { and, asc, eq, inArray } from 'drizzle-orm';

export interface StatusMapping {
  category: StatusCategory;
  blocked: boolean;
}

type IssueRow = typeof jiraIssues.$inferSelect;
type TransitionRow = Pick<
  typeof jiraIssueTransitions.$inferSelect,
  'at' | 'fromStatusId' | 'toStatusId'
>;
type ChangeRow = Pick<
  typeof jiraIssueChanges.$inferSelect,
  'at' | 'kind' | 'fromValue' | 'toValue'
>;

/** Statuses missing from the mapping (deleted in Jira, or never seen on the board) count as to-do. */
const UNMAPPED: StatusMapping = { category: 'todo', blocked: false };

const num = (v: string | null): number | null => {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * One stored issue + its ordered history → the metrics model. The issue starts in the `from` status
 * of its first transition (or its current status when it never moved).
 */
export function toMetricIssue(
  issue: IssueRow,
  transitions: TransitionRow[],
  changes: ChangeRow[],
  mappings: Map<string, StatusMapping>,
): MetricIssue {
  const map = (statusId: string) => mappings.get(statusId) ?? UNMAPPED;
  const created = issue.jiraCreatedAt;
  const periods: StatusPeriod[] = [];
  const push = (from: Date, statusId: string) => {
    const m = map(statusId);
    const at = from.getTime() < created.getTime() ? created : from;
    const last = periods.at(-1);
    if (last && last.category === m.category && last.blocked === m.blocked) return;
    if (last && last.from.getTime() === at.getTime()) periods.pop();
    periods.push({ from: at, category: m.category, blocked: m.blocked });
  };
  push(created, transitions[0]?.fromStatusId ?? transitions[0]?.toStatusId ?? issue.statusId);
  for (const t of transitions) push(t.at, t.toStatusId);

  const flagged: Interval[] = [];
  const flags = changes.filter((c) => c.kind === 'flag');
  let flaggedSince: Date | null = flags[0]?.fromValue === 'on' ? created : null;
  for (const c of flags) {
    if (c.toValue === 'on' && !flaggedSince) flaggedSince = c.at;
    if (c.toValue !== 'on' && flaggedSince) {
      flagged.push({ from: flaggedSince, to: c.at });
      flaggedSince = null;
    }
  }
  if (flaggedSince) flagged.push({ from: flaggedSince, to: null });

  return {
    id: issue.id,
    key: issue.key,
    summary: issue.summary,
    type: issue.issueType,
    createdAt: created,
    updatedAt: issue.jiraUpdatedAt,
    assignee: issue.assigneeName ?? issue.assigneeId,
    estimate: issue.estimate,
    estimateChanges: changes
      .filter((c) => c.kind === 'estimate')
      .map((c) => ({ at: c.at, from: num(c.fromValue), to: num(c.toValue) })),
    statusPeriods: periods,
    flagged,
  };
}

/**
 * Everything the metrics need for one board, read in a handful of queries. Sub-tasks are left
 * out: Jira's own sprint and flow reports count their parent items. null if the board is unknown.
 */
export async function loadBoardDataset(
  db: Db,
  orgId: string,
  boardId: string,
): Promise<BoardDataset | null> {
  return withOrg(db, orgId, async (tx) => {
    const [board] = await tx
      .select()
      .from(jiraBoards)
      .where(and(eq(jiraBoards.id, boardId), eq(jiraBoards.orgId, orgId)));
    if (!board) return null;
    const mappings = new Map(
      (
        await tx.select().from(jiraStatusMappings).where(eq(jiraStatusMappings.boardId, boardId))
      ).map((m) => [m.jiraStatusId, { category: m.category, blocked: m.blocked }]),
    );
    const onBoard = (issueCol: typeof jiraIssues.id | typeof jiraIssueTransitions.issueId) =>
      and(eq(jiraBoardIssues.boardId, boardId), eq(jiraBoardIssues.issueId, issueCol));

    const issues = (
      await tx
        .select({ issue: jiraIssues })
        .from(jiraIssues)
        .innerJoin(jiraBoardIssues, onBoard(jiraIssues.id))
        .where(eq(jiraIssues.isSubtask, false))
    ).map((r) => r.issue);
    const ids = new Set(issues.map((i) => i.id));

    const transitions = await tx
      .select({
        issueId: jiraIssueTransitions.issueId,
        at: jiraIssueTransitions.at,
        fromStatusId: jiraIssueTransitions.fromStatusId,
        toStatusId: jiraIssueTransitions.toStatusId,
      })
      .from(jiraIssueTransitions)
      .innerJoin(jiraBoardIssues, onBoard(jiraIssueTransitions.issueId))
      .orderBy(asc(jiraIssueTransitions.issueId), asc(jiraIssueTransitions.seq));
    const changes = await tx
      .select({
        issueId: jiraIssueChanges.issueId,
        at: jiraIssueChanges.at,
        kind: jiraIssueChanges.kind,
        fromValue: jiraIssueChanges.fromValue,
        toValue: jiraIssueChanges.toValue,
      })
      .from(jiraIssueChanges)
      .innerJoin(
        jiraBoardIssues,
        and(
          eq(jiraBoardIssues.boardId, boardId),
          eq(jiraBoardIssues.issueId, jiraIssueChanges.issueId),
        ),
      )
      .orderBy(asc(jiraIssueChanges.issueId), asc(jiraIssueChanges.seq));

    const sprints = (
      await tx
        .select({ sprint: jiraSprints })
        .from(jiraSprints)
        .innerJoin(
          jiraBoardSprints,
          and(eq(jiraBoardSprints.boardId, boardId), eq(jiraBoardSprints.sprintId, jiraSprints.id)),
        )
    ).map((r) => r.sprint);
    const sprintIds = sprints.map((s) => s.jiraSprintId);
    const membership =
      sprintIds.length === 0
        ? []
        : await tx
            .select()
            .from(jiraSprintIssues)
            .where(
              and(
                eq(jiraSprintIssues.connectionId, board.connectionId),
                eq(jiraSprintIssues.orgId, orgId),
                inArray(jiraSprintIssues.jiraSprintId, sprintIds),
              ),
            );

    const group = <T extends { issueId: string }>(rows: T[]) => {
      const byIssue = new Map<string, T[]>();
      for (const r of rows) byIssue.set(r.issueId, [...(byIssue.get(r.issueId) ?? []), r]);
      return byIssue;
    };
    const transitionsBy = group(transitions);
    const changesBy = group(changes);

    return {
      hasEstimates: board.estimationFieldId !== null,
      issues: issues.map((i) =>
        toMetricIssue(i, transitionsBy.get(i.id) ?? [], changesBy.get(i.id) ?? [], mappings),
      ),
      sprints: sprints.map(
        (s): MetricSprint => ({
          id: s.id,
          name: s.name,
          state: s.state,
          startAt: s.startAt,
          endAt: s.endAt,
          completeAt: s.completeAt,
          members: membership
            .filter((m) => m.jiraSprintId === s.jiraSprintId && ids.has(m.issueId))
            .map((m) => ({ issueId: m.issueId, addedAt: m.addedAt, removedAt: m.removedAt })),
        }),
      ),
    };
  });
}
