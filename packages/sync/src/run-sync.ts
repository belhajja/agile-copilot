import { randomUUID } from 'node:crypto';
import {
  jiraBoards,
  jiraConnections,
  jiraSyncRuns,
  jiraSyncStates,
  type Tx,
  withOrg,
} from '@agile/db';
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
import { and, eq, gt, isNull, lt, ne, or, sql } from 'drizzle-orm';
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
 * A run ends with `timed_out` after this long (F2: a very slow or hostile Jira must not hold a
 * worker slot for ever). Below the pg-boss job expiry (`SYNC_JOB_EXPIRE_SECONDS`, 30 min). Boards
 * read completely before it keep their progress.
 */
export const RUN_DEADLINE_MS = 25 * 60_000;

/** The run's lease was taken over (it stalled past `LEASE_MS`): it must not write any more. */
class LeaseLostError extends Error {
  override name = 'LeaseLostError';
  constructor() {
    super('The sync lease was taken over by another run');
  }
}

/**
 * Refreshes the lease, and proves this run still holds it: every write of a run happens in a
 * transaction that starts here. It locks the connection's state row, so a takeover (which
 * updates the same row) cannot slip between this check and the run's writes.
 */
async function fence(tx: Tx, connectionId: string, runId: string): Promise<void> {
  const held = await tx
    .update(jiraSyncStates)
    .set({ lastStartedAt: sql`now()` })
    .where(
      and(
        eq(jiraSyncStates.connectionId, connectionId),
        eq(jiraSyncStates.leaseRunId, runId),
        eq(jiraSyncStates.status, 'running'),
      ),
    )
    .returning({ connectionId: jiraSyncStates.connectionId });
  if (held.length === 0) throw new LeaseLostError();
}

/** A fresh lease (status running, refreshed within `LEASE_MS`, judged by the database clock). */
const freshLease = () =>
  and(
    eq(jiraSyncStates.status, 'running'),
    gt(jiraSyncStates.lastStartedAt, sql`now() - ${LEASE_MS} * interval '1 millisecond'`),
  );

/**
 * Syncs every selected board of one connection. Each board keeps its own progress: it is read
 * completely the first time (and once a day), otherwise only issues updated since ITS last
 * successful read started (minus an overlap), so one broken board never holds back the others.
 * Never throws for Jira/credential problems: the outcome and the stored sync state carry a code.
 * `deps.signal` stops the run at once, Jira requests and Retry-After waits included (code
 * `interrupted`, lease released); so does the run's own deadline (`timed_out`).
 *
 * One run per connection (the lease) and one per workspace: while another connection of the
 * workspace holds a fresh lease the run does not start (`workspace_busy`, retried by pg-boss).
 * Every write is fenced on the run's id: a run whose lease was taken over stops at its next write
 * (`already_running`) and never overwrites the new run's work.
 */
export async function runSync(deps: SyncDeps, job: SyncJob): Promise<SyncOutcome> {
  const clock = () => deps.now?.() ?? new Date();
  const now = clock();
  const runId = randomUUID();
  const lease = await withOrg(deps.db, job.orgId, async (tx) => {
    const [conn] = await tx
      .select({ id: jiraConnections.id })
      .from(jiraConnections)
      .where(eq(jiraConnections.id, job.connectionId));
    if (!conn) return null;
    // Lease decisions of one workspace are serialised (until this transaction ends), so two
    // connections starting at once cannot both see the workspace free.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`agile.jira_sync:${job.orgId}`}, 0))`,
    );
    const [other] = await tx
      .select({ connectionId: jiraSyncStates.connectionId })
      .from(jiraSyncStates)
      .where(
        and(
          eq(jiraSyncStates.orgId, job.orgId),
          ne(jiraSyncStates.connectionId, job.connectionId),
          freshLease(),
        ),
      )
      .limit(1);
    if (other) return 'busy' as const;
    await tx
      .insert(jiraSyncStates)
      .values({ orgId: job.orgId, connectionId: job.connectionId })
      .onConflictDoNothing();
    // Take the lease: only one sync per connection at a time. The lease is judged with the
    // DATABASE clock (workers' clocks may differ); deps.now only stamps the data we store.
    const [state] = await tx
      .update(jiraSyncStates)
      .set({ status: 'running', lastStartedAt: sql`now()`, leaseRunId: runId })
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
    if (!state) return { state: null, mode: 'full' as const };
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
        id: runId,
        orgId: job.orgId,
        connectionId: job.connectionId,
        trigger: job.trigger,
        mode,
        startedAt: now,
      })
      .returning({ id: jiraSyncRuns.id });
    if (!run) throw new Error('sync run insert returned nothing');
    return { state, mode };
  });
  if (!lease) return { ok: false, code: 'not_found' };
  if (lease === 'busy') return { ok: false, code: 'workspace_busy' };
  if (!lease.state) return { ok: false, code: 'already_running' };
  const { state, mode } = lease;

  // The run's signal: the caller's (pg-boss job, worker stop) and the run's own deadline. It
  // reaches every Jira request and Retry-After wait, not only the gaps between pages.
  const deadline = AbortSignal.timeout(deps.runDeadlineMs ?? RUN_DEADLINE_MS);
  const run: SyncDeps = {
    ...deps,
    signal: deps.signal ? AbortSignal.any([deps.signal, deadline]) : deadline,
  };

  let boardsSynced = 0;
  let issuesSynced = 0;
  try {
    checkSignal(run);
    const boards = await withOrg(run.db, job.orgId, (tx) =>
      tx
        .select()
        .from(jiraBoards)
        .where(and(eq(jiraBoards.connectionId, job.connectionId), eq(jiraBoards.selected, true))),
    );
    if (boards.length === 0) throw new SyncError('no_boards');
    const source = await openDataSource(run, job.orgId, job.connectionId);
    const sprintFieldId = findSprintField(await source.listFields());
    const statuses = new Map((await source.listStatuses()).map((s) => [s.id, s]));
    const failures: unknown[] = [];
    for (const board of boards) {
      checkSignal(run);
      const complete = readsCompletely(board, now);
      try {
        const count = await syncBoard(run, source, {
          orgId: job.orgId,
          connectionId: job.connectionId,
          runId,
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
        // rate-limit problems would hit every board, so those end the run at once, and so does a
        // stop, the deadline or a lost lease (whatever error the cut-off request surfaced as).
        if (run.signal?.aborted || e instanceof LeaseLostError) throw e;
        const code = codeOf(e);
        if (CONNECTION_WIDE_CODES.has(code)) throw e;
        // The board keeps its old watermark: its next read covers what this one missed.
        await withOrg(run.db, job.orgId, async (tx) => {
          await fence(tx, job.connectionId, runId);
          await tx.update(jiraBoards).set({ lastError: code }).where(eq(jiraBoards.id, board.id));
        });
        if (failures.length > 0) deps.onError?.(e, code); // the first is reported below
        failures.push(e);
      }
      await heartbeat(run, job, runId);
    }
    // The connection shows the first board failure (healthy boards have already advanced).
    if (failures.length > 0) throw failures[0];
    await withOrg(run.db, job.orgId, async (tx) => {
      await fence(tx, job.connectionId, runId);
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
    // Another run owns the connection now (and closed this run's row): leave everything to it.
    if (e instanceof LeaseLostError) return failureOf(deps, new SyncError('already_running'));
    // A request cut off by the deadline or a stop surfaces as a network error: name the cause.
    const cause = deadline.aborted
      ? new SyncError('timed_out')
      : deps.signal?.aborted
        ? new SyncError('interrupted')
        : e;
    const failure = failureOf(deps, cause);
    // Setting a non-running status releases the lease: a retry can start at once. Only while this
    // run still holds it: a lease taken over meanwhile belongs to the new run.
    await withOrg(deps.db, job.orgId, async (tx) => {
      const finished = clock();
      await tx
        .update(jiraSyncStates)
        .set({ status: 'error', lastError: failure.code, lastFinishedAt: finished })
        .where(
          and(
            eq(jiraSyncStates.connectionId, job.connectionId),
            eq(jiraSyncStates.leaseRunId, runId),
          ),
        );
      await tx
        .update(jiraSyncRuns)
        .set({
          status: 'error',
          error: failure.code,
          finishedAt: finished,
          boardsSynced,
          issuesUpserted: issuesSynced,
        })
        .where(and(eq(jiraSyncRuns.id, runId), eq(jiraSyncRuns.status, 'running')));
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
  /** The run holding the lease: every write is fenced on it. */
  runId: string;
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
    await fence(tx, j.connectionId, j.runId);
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
          await heartbeat(deps, j, j.runId);
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
          await fence(tx, j.connectionId, j.runId);
          return saveIssues(tx, j.orgId, j.connectionId, j.board.id, issues, j.now);
        })),
      );
      lastBeat = Date.now();
      checkSignal(deps);
    }
    await withOrg(deps.db, j.orgId, async (tx) => {
      await fence(tx, j.connectionId, j.runId);
      await ensureStatusMappings(tx, j.orgId, j.board.id, statusIds, j.statuses);
    });
  }
  await withOrg(deps.db, j.orgId, async (tx) => {
    await fence(tx, j.connectionId, j.runId);
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

/** Keeps the lease alive (a long, healthy run must not be taken over), or stops a fenced-off run. */
async function heartbeat(
  deps: SyncDeps,
  job: { orgId: string; connectionId: string },
  runId: string,
) {
  await withOrg(deps.db, job.orgId, (tx) => fence(tx, job.connectionId, runId));
}
