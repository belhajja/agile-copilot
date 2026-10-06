import {
  type Db,
  jiraBoardIssues,
  jiraBoardSprints,
  jiraIssues,
  jiraSprintIssues,
  jiraSprints,
  withOrg,
} from '@agile/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { type AnalyticsContext, requireBoard } from './boards';

export interface SprintSummary {
  jiraSprintId: number;
  name: string;
  state: 'future' | 'active' | 'closed';
  startAt: string | null;
  endAt: string | null;
  completeAt: string | null;
  goal: string | null;
  issueCount: number;
}

export interface ListSprintsInput {
  state?: 'active' | 'closed' | 'future';
  nameContains?: string;
  limit: number;
}

type SprintRow = typeof jiraSprints.$inferSelect;

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

/** Future sprints first, then by start date newest first (so "last sprint" questions find recent ones first). */
function byRecency(a: SprintRow, b: SprintRow): number {
  if (a.state === 'future' && b.state !== 'future') return -1;
  if (b.state === 'future' && a.state !== 'future') return 1;
  if (a.state === 'future' && b.state === 'future') return a.jiraSprintId - b.jiraSprintId;
  return (b.startAt?.getTime() ?? -Infinity) - (a.startAt?.getTime() ?? -Infinity);
}

/** Issues (the board's own, non-subtask) currently in each of these sprints, per Jira sprint id. */
async function issueCounts(
  db: Db,
  orgId: string,
  boardId: string,
  jiraSprintIds: readonly number[],
): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  if (jiraSprintIds.length === 0) return counts;
  const rows = await withOrg(db, orgId, (tx) =>
    tx
      .select({ jiraSprintId: jiraSprintIssues.jiraSprintId })
      .from(jiraSprintIssues)
      .innerJoin(
        jiraBoardIssues,
        and(
          eq(jiraBoardIssues.boardId, boardId),
          eq(jiraBoardIssues.issueId, jiraSprintIssues.issueId),
        ),
      )
      .innerJoin(
        jiraIssues,
        and(eq(jiraIssues.id, jiraSprintIssues.issueId), eq(jiraIssues.isSubtask, false)),
      )
      .where(
        and(
          inArray(jiraSprintIssues.jiraSprintId, jiraSprintIds),
          isNull(jiraSprintIssues.removedAt),
        ),
      ),
  );
  for (const r of rows) counts.set(r.jiraSprintId, (counts.get(r.jiraSprintId) ?? 0) + 1);
  return counts;
}

/**
 * A selected board's synced sprints with their official dates (see `jira_sprints`), read-only.
 * Re-checks the board against the caller's workspace (`requireBoard`); never the metrics dataset,
 * since this is listing, not computing.
 */
export async function listSprints(
  ctx: AnalyticsContext,
  boardId: string,
  input: ListSprintsInput,
): Promise<{ board: { id: string; name: string }; sprints: SprintSummary[]; hasMore: boolean }> {
  const board = await requireBoard(ctx, boardId);
  const rows = await withOrg(ctx.db, ctx.orgId, (tx) =>
    tx
      .select({ sprint: jiraSprints })
      .from(jiraSprints)
      .innerJoin(
        jiraBoardSprints,
        and(eq(jiraBoardSprints.boardId, boardId), eq(jiraBoardSprints.sprintId, jiraSprints.id)),
      )
      .where(input.state ? eq(jiraSprints.state, input.state) : undefined),
  );
  const nameContains = input.nameContains?.toLowerCase();
  const matching = rows
    .map((r) => r.sprint)
    .filter((s) => !nameContains || s.name.toLowerCase().includes(nameContains))
    .sort(byRecency);

  const page = matching.slice(0, input.limit);
  const counts = await issueCounts(
    ctx.db,
    ctx.orgId,
    boardId,
    page.map((s) => s.jiraSprintId),
  );
  return {
    board: { id: board.id, name: board.name },
    sprints: page.map((s) => ({
      jiraSprintId: s.jiraSprintId,
      name: s.name,
      state: s.state,
      startAt: iso(s.startAt),
      endAt: iso(s.endAt),
      completeAt: iso(s.completeAt),
      goal: s.goal,
      issueCount: counts.get(s.jiraSprintId) ?? 0,
    })),
    hasMore: matching.length > input.limit,
  };
}
