import { jiraBoards, jiraConnections, jiraSyncRuns, jiraSyncStates, withOrg } from '@agile/db';
import {
  buildIssueJql,
  completeHistories,
  errorStatus,
  findSprintField,
  issueFieldList,
  type JiraBoardConfig,
  type JiraDataSource,
  type JiraStatusInfo,
  type NormalizedIssue,
  normalizeIssue,
} from '@agile/jira';
import { and, eq, isNull, lt, ne, or } from 'drizzle-orm';
import { failureOf } from './boards';
import { openDataSource } from './credentials';
import { type SyncDeps, SyncError, type SyncFailure } from './deps';
import {
  ensureStatusMappings,
  pruneBoardIssues,
  saveBoardConfig,
  saveIssues,
  saveSprints,
} from './persist';

export interface SyncJob {
  orgId: string;
  connectionId: string;
  trigger: 'manual' | 'schedule';
}

export type SyncOutcome =
  | { ok: true; mode: 'full' | 'incremental'; boards: number; issues: number }
  | SyncFailure;

/** A full re-read (which also drops issues that left a board) at least this often. */
export const FULL_SYNC_EVERY_MS = 24 * 3_600_000;
/** A "running" lease older than this is considered abandoned (crashed worker). */
const LEASE_MS = 3_600_000;

/**
 * Syncs every selected board of one connection. First run (and once a day) reads everything;
 * otherwise only issues updated since the last successful sync started (minus an overlap).
 * Never throws for Jira/credential problems: the outcome and the stored sync state carry a code.
 */
export async function runSync(deps: SyncDeps, job: SyncJob): Promise<SyncOutcome> {
  const clock = () => deps.now?.() ?? new Date();
  const now = clock();
  const lease = await withOrg(deps.db, job.orgId, async (tx) => {
    const [conn] = await tx
      .select({ id: jiraConnections.id })
      .from(jiraConnections)
      .where(eq(jiraConnections.id, job.connectionId));
    if (!conn) return null;
    await tx
      .insert(jiraSyncStates)
      .values({ orgId: job.orgId, connectionId: job.connectionId })
      .onConflictDoNothing();
    // Take the lease: only one sync per connection at a time.
    const [state] = await tx
      .update(jiraSyncStates)
      .set({ status: 'running', lastStartedAt: now })
      .where(
        and(
          eq(jiraSyncStates.connectionId, job.connectionId),
          or(
            ne(jiraSyncStates.status, 'running'),
            isNull(jiraSyncStates.lastStartedAt),
            lt(jiraSyncStates.lastStartedAt, new Date(now.getTime() - LEASE_MS)),
          ),
        ),
      )
      .returning();
    if (!state) return { state: null, runId: null, mode: 'full' as const };
    const mode: 'full' | 'incremental' =
      !state.watermark ||
      !state.lastFullSyncAt ||
      now.getTime() - state.lastFullSyncAt.getTime() >= FULL_SYNC_EVERY_MS
        ? 'full'
        : 'incremental';
    const [run] = await tx
      .insert(jiraSyncRuns)
      .values({
        orgId: job.orgId,
        connectionId: job.connectionId,
        trigger: job.trigger,
        mode,
        startedAt: now,
      })
      .returning({ id: jiraSyncRuns.id });
    return { state, runId: run?.id ?? null, mode };
  });
  if (!lease) return { ok: false, code: 'not_found' };
  if (!lease.state || !lease.runId) return { ok: false, code: 'already_running' };
  const { state, runId, mode } = lease;

  let boardsSynced = 0;
  let issuesSynced = 0;
  try {
    const boards = await withOrg(deps.db, job.orgId, (tx) =>
      tx
        .select()
        .from(jiraBoards)
        .where(and(eq(jiraBoards.connectionId, job.connectionId), eq(jiraBoards.selected, true))),
    );
    if (boards.length === 0) throw new SyncError('no_boards');
    const source = await openDataSource(deps, job.orgId, job.connectionId);
    const sprintFieldId = findSprintField(await source.listFields());
    const statuses = new Map((await source.listStatuses()).map((s) => [s.id, s]));
    for (const board of boards) {
      const count = await syncBoard(deps, source, {
        orgId: job.orgId,
        connectionId: job.connectionId,
        board,
        since: mode === 'full' ? null : state.watermark,
        now,
        mode,
        sprintFieldId,
        statuses,
      });
      if (count === null) continue;
      boardsSynced++;
      issuesSynced += count;
    }
    await withOrg(deps.db, job.orgId, async (tx) => {
      const finished = clock();
      await tx
        .update(jiraSyncStates)
        .set({
          status: 'ok',
          watermark: now,
          lastFullSyncAt: mode === 'full' ? now : state.lastFullSyncAt,
          lastFinishedAt: finished,
          lastSuccessAt: finished,
          lastError: null,
        })
        .where(eq(jiraSyncStates.connectionId, job.connectionId));
      await tx
        .update(jiraSyncRuns)
        .set({ status: 'ok', finishedAt: finished, boardsSynced, issuesUpserted: issuesSynced })
        .where(eq(jiraSyncRuns.id, runId));
    });
    return { ok: true, mode, boards: boardsSynced, issues: issuesSynced };
  } catch (e) {
    const failure = failureOf(deps, e);
    await withOrg(deps.db, job.orgId, async (tx) => {
      const finished = clock();
      await tx
        .update(jiraSyncStates)
        .set({ status: 'error', lastError: failure.code, lastFinishedAt: finished })
        .where(eq(jiraSyncStates.connectionId, job.connectionId));
      await tx
        .update(jiraSyncRuns)
        .set({
          status: 'error',
          error: failure.code,
          finishedAt: finished,
          boardsSynced,
          issuesUpserted: issuesSynced,
        })
        .where(eq(jiraSyncRuns.id, runId));
    });
    return failure;
  }
}

interface BoardJob {
  orgId: string;
  connectionId: string;
  board: typeof jiraBoards.$inferSelect;
  since: Date | null;
  now: Date;
  mode: 'full' | 'incremental';
  sprintFieldId: string | null;
  statuses: Map<string, JiraStatusInfo>;
}

/** Returns the number of issues read, or null when the board no longer exists in Jira. */
async function syncBoard(
  deps: SyncDeps,
  source: JiraDataSource,
  j: BoardJob,
): Promise<number | null> {
  let config: JiraBoardConfig;
  try {
    config = await source.getBoardConfig(j.board.jiraBoardId);
  } catch (e) {
    if (errorStatus(e) === 404) return null;
    throw e;
  }
  const sprints = j.board.type === 'scrum' ? await source.listSprints(j.board.jiraBoardId) : [];
  await withOrg(deps.db, j.orgId, async (tx) => {
    await saveBoardConfig(tx, j.board.id, config);
    await saveSprints(tx, j.orgId, j.connectionId, j.board.id, sprints);
    await ensureStatusMappings(
      tx,
      j.orgId,
      j.board.id,
      config.columns.flatMap((c) => c.statusIds),
      j.statuses,
    );
  });
  if (config.filterId === null) return 0;

  const ctx = {
    estimationFieldId: config.estimationFieldId,
    estimationFieldName: config.estimationFieldName,
    sprintFieldId: j.sprintFieldId,
  };
  const seen: string[] = [];
  const statusIds = new Set<string>();
  for await (const page of source.searchIssues(
    buildIssueJql(config.filterId, j.since, j.now),
    issueFieldList(ctx),
  )) {
    const issues: NormalizedIssue[] = [];
    for (const raw of page) {
      const issue = normalizeIssue(raw, await completeHistories(source, raw), ctx);
      issues.push(issue);
      statusIds.add(issue.statusId);
      for (const t of issue.transitions) {
        statusIds.add(t.toStatusId);
        if (t.fromStatusId) statusIds.add(t.fromStatusId);
      }
    }
    seen.push(
      ...(await withOrg(deps.db, j.orgId, (tx) =>
        saveIssues(tx, j.orgId, j.connectionId, j.board.id, issues, j.now),
      )),
    );
  }
  await withOrg(deps.db, j.orgId, async (tx) => {
    await ensureStatusMappings(tx, j.orgId, j.board.id, statusIds, j.statuses);
    if (j.mode === 'full') await pruneBoardIssues(tx, j.board.id, seen);
    await tx.update(jiraBoards).set({ lastSyncedAt: j.now }).where(eq(jiraBoards.id, j.board.id));
  });
  return seen.length;
}
