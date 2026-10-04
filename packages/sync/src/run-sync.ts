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
import { and, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { codeOf, failureOf } from './boards';
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
    // Take the lease: only one sync per connection at a time. The lease is judged with the
    // DATABASE clock (workers' clocks may differ); deps.now only stamps the data we store.
    const [state] = await tx
      .update(jiraSyncStates)
      .set({ status: 'running', lastStartedAt: sql`now()` })
      .where(
        and(
          eq(jiraSyncStates.connectionId, job.connectionId),
          or(
            ne(jiraSyncStates.status, 'running'),
            isNull(jiraSyncStates.lastStartedAt),
            lt(jiraSyncStates.lastStartedAt, sql`now() - ${LEASE_MS} * interval '1 millisecond'`),
          ),
        ),
      )
      .returning();
    if (!state) return { state: null, runId: null, mode: 'full' as const };
    // A takeover means the previous worker died: close its run rows.
    await tx
      .update(jiraSyncRuns)
      .set({ status: 'error', error: 'abandoned', finishedAt: sql`now()` })
      .where(
        and(eq(jiraSyncRuns.connectionId, job.connectionId), eq(jiraSyncRuns.status, 'running')),
      );
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
    const failures: unknown[] = [];
    for (const board of boards) {
      // A board never read before (selected after the last sync) is read completely.
      const complete = mode === 'full' || board.lastSyncedAt === null;
      try {
        const count = await syncBoard(deps, source, {
          orgId: job.orgId,
          connectionId: job.connectionId,
          board,
          since: complete ? null : state.watermark,
          clock,
          mode: complete ? 'full' : 'incremental',
          now,
          sprintFieldId,
          statuses,
        });
        if (count !== null) {
          boardsSynced++;
          issuesSynced += count;
        }
      } catch (e) {
        // One broken board (e.g. its filter was deleted) must not stop the others; credential and
        // rate-limit problems would hit every board, so those end the run at once.
        if (isConnectionWide(e)) throw e;
        if (failures.length > 0) deps.onError?.(e, codeOf(e)); // the first is reported below
        failures.push(e);
      }
      await heartbeat(deps, job);
    }
    // The first failure is the run's code; the watermark does not move.
    if (failures.length > 0) throw failures[0];
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
  clock: () => Date;
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
    // Jira evaluates "-Nm" when it receives the request, so measure from the clock now.
    buildIssueJql(config.filterId, j.since, j.clock()),
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
      ...(await withOrg(deps.db, j.orgId, async (tx) => {
        await tx
          .update(jiraSyncStates)
          .set({ lastStartedAt: sql`now()` })
          .where(eq(jiraSyncStates.connectionId, j.connectionId));
        return saveIssues(tx, j.orgId, j.connectionId, j.board.id, issues, j.now);
      })),
    );
  }
  await withOrg(deps.db, j.orgId, async (tx) => {
    await ensureStatusMappings(tx, j.orgId, j.board.id, statusIds, j.statuses);
    if (j.mode === 'full') await pruneBoardIssues(tx, j.board.id, seen);
    await tx.update(jiraBoards).set({ lastSyncedAt: j.now }).where(eq(jiraBoards.id, j.board.id));
  });
  return seen.length;
}

/** Keeps the lease alive: a long, healthy run must not be taken over after an hour. */
async function heartbeat(deps: SyncDeps, job: SyncJob) {
  await withOrg(deps.db, job.orgId, (tx) =>
    tx
      .update(jiraSyncStates)
      .set({ lastStartedAt: sql`now()` })
      .where(eq(jiraSyncStates.connectionId, job.connectionId)),
  );
}

const CONNECTION_WIDE = new Set(['unauthorized', 'forbidden', 'rate_limited', 'unreachable']);
const isConnectionWide = (e: unknown) => CONNECTION_WIDE.has(codeOf(e));
