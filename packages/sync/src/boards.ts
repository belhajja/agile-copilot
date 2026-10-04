import { type Actor, assertCanManage, recordAudit } from '@agile/connections';
import {
  jiraBoards,
  jiraConnections,
  jiraStatusMappings,
  jiraSyncStates,
  withOrg,
} from '@agile/db';
import {
  type JiraBoardConfig,
  type JiraBoardInfo,
  JiraPaginationError,
  JiraPaginationLimitError,
  type JiraStatusInfo,
  mapJiraError,
} from '@agile/jira';
import { and, asc, eq, inArray, notInArray } from 'drizzle-orm';
import { openDataSource } from './credentials';
import { type SyncDeps, SyncError, type SyncFailure, type SyncFailureCode } from './deps';
import { ensureStatusMappings } from './persist';

export interface BoardView {
  id: string;
  connectionId: string;
  jiraBoardId: number;
  name: string;
  type: 'scrum' | 'kanban' | 'simple';
  projectKey: string | null;
  selected: boolean;
  usesEstimates: boolean;
  lastSyncedAt: Date | null;
}

export interface StatusMappingView {
  jiraStatusId: string;
  statusName: string;
  jiraCategory: string;
  category: 'todo' | 'in_progress' | 'done';
  blocked: boolean;
  source: 'auto' | 'user';
}

export interface SyncStateView {
  status: 'idle' | 'queued' | 'running' | 'ok' | 'error';
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
}

const toBoardView = (b: typeof jiraBoards.$inferSelect): BoardView => ({
  id: b.id,
  connectionId: b.connectionId,
  jiraBoardId: b.jiraBoardId,
  name: b.name,
  type: b.type,
  projectKey: b.projectKey,
  selected: b.selected,
  usesEstimates: b.estimationFieldId !== null,
  lastSyncedAt: b.lastSyncedAt,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const CATEGORIES = new Set(['todo', 'in_progress', 'done']);

/** Maps an error to a stable code (reported to deps.onError for logging). */
export function codeOf(e: unknown): SyncFailureCode {
  if (e instanceof SyncError) return e.code;
  if (e instanceof JiraPaginationError || e instanceof JiraPaginationLimitError)
    return 'jira_paging';
  return mapJiraError(e).code;
}

export function failureOf(deps: SyncDeps, e: unknown): SyncFailure {
  const code = codeOf(e);
  deps.onError?.(e, code);
  return { ok: false, code };
}

export async function listBoards(
  deps: SyncDeps,
  orgId: string,
  connectionId: string,
): Promise<BoardView[]> {
  if (!isUuid(connectionId)) return [];
  const rows = await withOrg(deps.db, orgId, (tx) =>
    tx
      .select()
      .from(jiraBoards)
      .where(eq(jiraBoards.connectionId, connectionId))
      .orderBy(asc(jiraBoards.name)),
  );
  return rows.map(toBoardView);
}

/** All selected boards of the workspace (dashboard navigation). */
export async function listSelectedBoards(deps: SyncDeps, orgId: string): Promise<BoardView[]> {
  const rows = await withOrg(deps.db, orgId, (tx) =>
    tx.select().from(jiraBoards).where(eq(jiraBoards.selected, true)).orderBy(asc(jiraBoards.name)),
  );
  return rows.map(toBoardView);
}

export async function getBoard(deps: SyncDeps, orgId: string, boardId: string) {
  if (!isUuid(boardId)) return null;
  const [row] = await withOrg(deps.db, orgId, (tx) =>
    tx.select().from(jiraBoards).where(eq(jiraBoards.id, boardId)),
  );
  return row ? toBoardView(row) : null;
}

/**
 * Reads the connection's boards from Jira and stores them with their configuration (selection is
 * kept). Boards Jira no longer returns are removed with everything synced for them. Statuses of
 * each board's columns get a suggested mapping unless one exists.
 */
export async function discoverBoards(
  deps: SyncDeps,
  actor: Actor,
  connectionId: string,
): Promise<{ ok: true; boards: BoardView[] } | SyncFailure> {
  assertCanManage(actor);
  if (!isUuid(connectionId)) return { ok: false, code: 'not_found' };
  const found: { info: JiraBoardInfo; config: JiraBoardConfig }[] = [];
  let statuses: JiraStatusInfo[];
  try {
    const source = await openDataSource(deps, actor.orgId, connectionId);
    statuses = await source.listStatuses();
    // One board at a time: Jira rate-limits bursts.
    for (const info of await source.listBoards()) {
      found.push({ info, config: await source.getBoardConfig(info.jiraBoardId) });
    }
  } catch (e) {
    return failureOf(deps, e);
  }
  const statusById = new Map(statuses.map((s) => [s.id, s]));
  return withOrg(deps.db, actor.orgId, async (tx) => {
    // Parent ids are only ever taken from a read in this tenant (FK checks bypass RLS).
    const [conn] = await tx
      .select({ id: jiraConnections.id })
      .from(jiraConnections)
      .where(eq(jiraConnections.id, connectionId));
    if (!conn) return { ok: false, code: 'not_found' } as const;
    // A listing that came back empty (e.g. the token lost browse permission) must not wipe the
    // selection and mappings of boards we already know.
    if (found.length === 0) {
      const [known] = await tx
        .select({ id: jiraBoards.id })
        .from(jiraBoards)
        .where(eq(jiraBoards.connectionId, connectionId))
        .limit(1);
      if (known) return { ok: false, code: 'no_boards' } as const;
    }
    for (const { info, config } of found) {
      const [board] = await tx
        .insert(jiraBoards)
        .values({
          orgId: actor.orgId,
          connectionId,
          jiraBoardId: info.jiraBoardId,
          name: info.name,
          type: info.type,
          projectKey: info.projectKey,
          filterId: config.filterId,
          estimationFieldId: config.estimationFieldId,
          estimationFieldName: config.estimationFieldName,
          columns: config.columns,
        })
        .onConflictDoUpdate({
          target: [jiraBoards.connectionId, jiraBoards.jiraBoardId],
          set: {
            name: info.name,
            type: info.type,
            projectKey: info.projectKey,
            filterId: config.filterId,
            estimationFieldId: config.estimationFieldId,
            estimationFieldName: config.estimationFieldName,
            columns: config.columns,
          },
        })
        .returning({ id: jiraBoards.id });
      if (!board) continue;
      await ensureStatusMappings(
        tx,
        actor.orgId,
        board.id,
        config.columns.flatMap((c) => c.statusIds),
        statusById,
      );
    }
    const keep = found.map((f) => f.info.jiraBoardId);
    await tx
      .delete(jiraBoards)
      .where(
        keep.length === 0
          ? eq(jiraBoards.connectionId, connectionId)
          : and(
              eq(jiraBoards.connectionId, connectionId),
              notInArray(jiraBoards.jiraBoardId, keep),
            ),
      );
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'jira_boards.discovered',
      targetType: 'jira_connection',
      targetId: connectionId,
      metadata: { boards: found.length },
    });
    return { ok: true } as const;
  }).then(async (r) =>
    r.ok ? { ok: true as const, boards: await listBoards(deps, actor.orgId, connectionId) } : r,
  );
}

/** Selects exactly `boardIds` (ids of this connection's boards; others are ignored). */
export async function setBoardSelection(
  deps: SyncDeps,
  actor: Actor,
  connectionId: string,
  boardIds: string[],
): Promise<{ ok: true; selected: number } | SyncFailure> {
  assertCanManage(actor);
  if (!isUuid(connectionId)) return { ok: false, code: 'not_found' };
  const ids = boardIds.filter(isUuid);
  return withOrg(deps.db, actor.orgId, async (tx) => {
    const [conn] = await tx
      .select({ id: jiraConnections.id })
      .from(jiraConnections)
      .where(eq(jiraConnections.id, connectionId));
    if (!conn) return { ok: false, code: 'not_found' } as const;
    await tx
      .update(jiraBoards)
      .set({ selected: false })
      .where(eq(jiraBoards.connectionId, connectionId));
    const selected =
      ids.length === 0
        ? []
        : await tx
            .update(jiraBoards)
            .set({ selected: true })
            .where(and(eq(jiraBoards.connectionId, connectionId), inArray(jiraBoards.id, ids)))
            .returning({ id: jiraBoards.id });
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'jira_boards.selection_changed',
      targetType: 'jira_connection',
      targetId: connectionId,
      metadata: { selected: selected.length },
    });
    return { ok: true, selected: selected.length } as const;
  });
}

export async function listStatusMappings(
  deps: SyncDeps,
  orgId: string,
  boardId: string,
): Promise<StatusMappingView[]> {
  if (!isUuid(boardId)) return [];
  const rows = await withOrg(deps.db, orgId, (tx) =>
    tx
      .select()
      .from(jiraStatusMappings)
      .where(eq(jiraStatusMappings.boardId, boardId))
      .orderBy(asc(jiraStatusMappings.statusName)),
  );
  return rows.map((r) => ({
    jiraStatusId: r.jiraStatusId,
    statusName: r.statusName,
    jiraCategory: r.jiraCategory,
    category: r.category,
    blocked: r.blocked,
    source: r.source,
  }));
}

/** Saves the user's mapping for statuses the board already knows; unknown status ids are ignored. */
export async function saveStatusMappings(
  deps: SyncDeps,
  actor: Actor,
  boardId: string,
  entries: { jiraStatusId: string; category: 'todo' | 'in_progress' | 'done'; blocked: boolean }[],
): Promise<{ ok: true; updated: number } | SyncFailure> {
  assertCanManage(actor);
  if (!isUuid(boardId)) return { ok: false, code: 'not_found' };
  if (entries.some((e) => !CATEGORIES.has(e.category))) return { ok: false, code: 'invalid_input' };
  // One entry per status, the last one wins.
  const unique = [...new Map(entries.map((e) => [e.jiraStatusId, e])).values()];
  return withOrg(deps.db, actor.orgId, async (tx) => {
    let updated = 0;
    for (const e of unique) {
      const rows = await tx
        .update(jiraStatusMappings)
        .set({
          category: e.category,
          // Only in-progress statuses can be waits; done/to-do time is not part of cycle time.
          blocked: e.category === 'in_progress' && e.blocked,
          source: 'user',
        })
        .where(
          and(
            eq(jiraStatusMappings.boardId, boardId),
            eq(jiraStatusMappings.jiraStatusId, e.jiraStatusId),
          ),
        )
        .returning({ id: jiraStatusMappings.jiraStatusId });
      updated += rows.length;
    }
    if (updated === 0) return { ok: false, code: 'not_found' } as const;
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'jira_status_mapping.updated',
      targetType: 'jira_board',
      targetId: boardId,
      metadata: { statuses: updated },
    });
    return { ok: true, updated } as const;
  });
}

export async function getSyncState(
  deps: SyncDeps,
  orgId: string,
  connectionId: string,
): Promise<SyncStateView> {
  const [row] = await withOrg(deps.db, orgId, (tx) =>
    tx.select().from(jiraSyncStates).where(eq(jiraSyncStates.connectionId, connectionId)),
  );
  return {
    status: row?.status ?? 'idle',
    lastStartedAt: row?.lastStartedAt ?? null,
    lastFinishedAt: row?.lastFinishedAt ?? null,
    lastSuccessAt: row?.lastSuccessAt ?? null,
    lastError: row?.lastError ?? null,
  };
}
