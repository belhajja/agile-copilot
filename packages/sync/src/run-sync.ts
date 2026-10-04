import { jiraBoards, jiraConnections, jiraSyncRuns, jiraSyncStates, withOrg } from '@agile/db';
import {
  buildIssueJql,
  completeHistories,
  errorStatus,
  findSprintField,
  issueFieldList,
  type JiraBoardConfig,
  type JiraDataSource,
  type JiraSprintInfo,
  type JiraStatusInfo,
  type NormalizedIssue,
  normalizeIssue,
  type RawIssue,
} from '@agile/jira';
import { and, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { codeOf, failureOf } from './boards';
import { openDataSource } from './credentials';
import { CONNECTION_WIDE_CODES, type SyncDeps, SyncError, type SyncFailure } from './deps';
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
/**
 * A "running" lease older than this is considered abandoned (crashed worker). Healthy runs refresh
 * it after every page and every board (and while completing long changelogs).
 */
export const LEASE_MS = 10 * 60_000;
/** Lease refreshes inside one page are throttled to this interval. */
const HEARTBEAT_EVERY_MS = 60_000;

/**
 * Syncs every selected board of one connection. Each board keeps its own progress: it is read
 * completely the first time (and once a day), otherwise only issues updated since ITS last
 * successful read started (minus an overlap), so one broken board never holds back the others.
 * Never throws for Jira/credential problems: the outcome and the stored sync state carry a code.
 * `deps.signal` stops the run between pages and boards (code `interrupted`, lease released).
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
    const selected = await tx
      .select({ lastFullSyncAt: jiraBoards.lastFullSyncAt, watermark: jiraBoards.watermark })
      .from(jiraBoards)
      .where(and(eq(jiraBoards.connectionId, job.connectionId), eq(jiraBoards.selected, true)));
    // The run is "full" when every board is read completely (the first sync, the daily re-read).
    const mode: 'full' | 'incremental' =
      selected.length > 0 && selected.every((b) => readsCompletely(b, now))
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
    checkSignal(deps);
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
      checkSignal(deps);
      const complete = readsCompletely(board, now);
      try {
        const count = await syncBoard(deps, source, {
          orgId: job.orgId,
          connectionId: job.connectionId,
          board,
          since: complete ? null : board.watermark,
          clock,
          mode: complete ? 'full' : 'incremental',
          now,
          sprintFieldId,
          statuses,
        });
        boardsSynced++;
        issuesSynced += count;
      } catch (e) {
        // One broken board (e.g. its filter was deleted) must not stop the others; credential and
        // rate-limit problems would hit every board, so those end the run at once.
        const code = codeOf(e);
        if (CONNECTION_WIDE_CODES.has(code)) throw e;
        // The board keeps its old watermark: its next read covers what this one missed.
        await withOrg(deps.db, job.orgId, (tx) =>
          tx.update(jiraBoards).set({ lastError: code }).where(eq(jiraBoards.id, board.id)),
        );
        if (failures.length > 0) deps.onError?.(e, code); // the first is reported below
        failures.push(e);
      }
      await heartbeat(deps, job);
    }
    // The connection shows the first board failure (healthy boards have already advanced).
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
    // Setting a non-running status releases the lease: a retry can start at once.
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

/** A board is read completely the first time, and again once a day (drops issues that left it). */
function readsCompletely(
  board: { lastFullSyncAt: Date | null; watermark: Date | null },
  now: Date,
): boolean {
  return (
    !board.watermark ||
    !board.lastFullSyncAt ||
    now.getTime() - board.lastFullSyncAt.getTime() >= FULL_SYNC_EVERY_MS
  );
}

function checkSignal(deps: SyncDeps) {
  if (deps.signal?.aborted) throw new SyncError('interrupted');
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

/** Returns the number of issues read; a failure leaves the board's progress untouched. */
async function syncBoard(deps: SyncDeps, source: JiraDataSource, j: BoardJob): Promise<number> {
  let config: JiraBoardConfig;
  try {
    config = await source.getBoardConfig(j.board.jiraBoardId);
  } catch (e) {
    if (errorStatus(e) === 404) throw new SyncError('board_not_found');
    throw e;
  }
  const sprints = await listBoardSprints(source, j.board);
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
  const seen: string[] = [];
  const filterId = config.filterId;
  if (filterId !== null) {
    const ctx = {
      estimationFieldId: config.estimationFieldId,
      estimationFieldName: config.estimationFieldName,
      sprintFieldId: j.sprintFieldId,
    };
    const statusIds = new Set<string>();
    let lastBeat = Date.now();
    const pages = boardQuery(() =>
      source.searchIssues(
        // Jira evaluates "-Nm" when it receives the request, so measure from the clock now.
        buildIssueJql(filterId, j.since, j.clock()),
        issueFieldList(ctx),
      ),
    );
    for await (const page of pages) {
      const issues: NormalizedIssue[] = [];
      for (const raw of page) {
        // Long changelogs are fetched one issue at a time: keep the lease fresh meanwhile.
        if (Date.now() - lastBeat >= HEARTBEAT_EVERY_MS) {
          checkSignal(deps);
          await heartbeat(deps, j);
          lastBeat = Date.now();
        }
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
      lastBeat = Date.now();
      checkSignal(deps);
    }
    await withOrg(deps.db, j.orgId, (tx) =>
      ensureStatusMappings(tx, j.orgId, j.board.id, statusIds, j.statuses),
    );
  }
  await withOrg(deps.db, j.orgId, async (tx) => {
    if (j.mode === 'full') await pruneBoardIssues(tx, j.board.id, seen);
    await tx
      .update(jiraBoards)
      .set({
        lastSyncedAt: j.now,
        watermark: j.now,
        lastFullSyncAt: j.mode === 'full' ? j.now : j.board.lastFullSyncAt,
        lastError: null,
      })
      .where(eq(jiraBoards.id, j.board.id));
  });
  return seen.length;
}

/**
 * Scrum boards have sprints; so do team-managed ("simple") boards whose project turned them on.
 * For those Jira answers 400 (or 404) when sprints are off: that means "no sprints".
 */
async function listBoardSprints(
  source: JiraDataSource,
  board: typeof jiraBoards.$inferSelect,
): Promise<JiraSprintInfo[]> {
  if (board.type === 'kanban') return [];
  if (board.type === 'scrum') return source.listSprints(board.jiraBoardId);
  try {
    return await source.listSprints(board.jiraBoardId);
  } catch (e) {
    const status = errorStatus(e);
    if (status === 400 || status === 404) return [];
    throw e;
  }
}

/** Jira answers 400 when a board's saved filter is broken (deleted, no longer shared, bad JQL). */
async function* boardQuery(search: () => AsyncGenerator<RawIssue[]>): AsyncGenerator<RawIssue[]> {
  try {
    yield* search();
  } catch (e) {
    if (errorStatus(e) === 400) throw new SyncError('board_query_rejected');
    throw e;
  }
}

/** Keeps the lease alive: a long, healthy run must not be taken over. */
async function heartbeat(deps: SyncDeps, job: { orgId: string; connectionId: string }) {
  await withOrg(deps.db, job.orgId, (tx) =>
    tx
      .update(jiraSyncStates)
      .set({ lastStartedAt: sql`now()` })
      .where(eq(jiraSyncStates.connectionId, job.connectionId)),
  );
}
