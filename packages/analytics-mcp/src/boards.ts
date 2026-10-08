import { loadBoardDataset } from '@agile/dashboards';
import { type Db, isUuid, jiraBoards, jiraConnections, withOrg } from '@agile/db';
import type { BoardDataset } from '@agile/metrics';
import { and, asc, eq } from 'drizzle-orm';

/** Who is asking, fixed by the server when the MCP server is created (never by the model). */
export interface AnalyticsContext {
  db: Db;
  orgId: string;
  now: () => Date;
}

export interface BoardSummary {
  id: string;
  name: string;
  type: 'scrum' | 'kanban' | 'simple';
  projectKey: string | null;
  site: string;
  lastSyncedAt: string | null;
}

/** Selected (synced) boards of the caller's workspace; only `boardId` when given. */
async function selectedBoards(ctx: AnalyticsContext, boardId?: string): Promise<BoardSummary[]> {
  const rows = await withOrg(ctx.db, ctx.orgId, (tx) =>
    tx
      .select({
        id: jiraBoards.id,
        name: jiraBoards.name,
        type: jiraBoards.type,
        projectKey: jiraBoards.projectKey,
        site: jiraConnections.name,
        lastSyncedAt: jiraBoards.lastSyncedAt,
      })
      .from(jiraBoards)
      .innerJoin(jiraConnections, eq(jiraConnections.id, jiraBoards.connectionId))
      .where(
        and(
          eq(jiraBoards.orgId, ctx.orgId),
          eq(jiraBoards.selected, true),
          boardId === undefined ? undefined : eq(jiraBoards.id, boardId),
        ),
      )
      .orderBy(asc(jiraBoards.name)),
  );
  return rows.map((r) => ({ ...r, lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null }));
}

/** Selected (synced) boards of the caller's workspace. */
export const listBoardSummaries = (ctx: AnalyticsContext): Promise<BoardSummary[]> =>
  selectedBoards(ctx);

export class UnknownBoardError extends Error {
  override name = 'UnknownBoardError';
  constructor() {
    super('Unknown board: call list_boards and use one of its ids.');
  }
}

/**
 * A selected board of the caller's workspace (tenant-checked), without loading its metrics
 * dataset. Any other id (malformed, another workspace's, not selected) is "unknown": the model
 * learns nothing about other tenants.
 */
export async function requireBoard(ctx: AnalyticsContext, boardId: string): Promise<BoardSummary> {
  if (!isUuid(boardId)) throw new UnknownBoardError();
  const [board] = await selectedBoards(ctx, boardId);
  if (!board) throw new UnknownBoardError();
  return board;
}

export type DatasetLoader = (boardId: string) => Promise<BoardDataset | null>;

/**
 * Loads each board's dataset at most once: one server serves one chat turn, where the model often
 * asks several questions about the same board. A failed load is not kept, the next call retries.
 */
export function cachedDatasetLoader(ctx: AnalyticsContext): DatasetLoader {
  const loads = new Map<string, Promise<BoardDataset | null>>();
  return (boardId) => {
    const cached = loads.get(boardId);
    if (cached) return cached;
    const load = loadBoardDataset(ctx.db, ctx.orgId, boardId);
    loads.set(boardId, load);
    load.catch(() => {
      if (loads.get(boardId) === load) loads.delete(boardId);
    });
    return load;
  };
}

/** A selected board of the caller's workspace and its dataset (see `requireBoard`). */
export async function openBoard(
  ctx: AnalyticsContext,
  boardId: string,
  loadDataset: DatasetLoader = (id) => loadBoardDataset(ctx.db, ctx.orgId, id),
): Promise<{ board: BoardSummary; dataset: BoardDataset }> {
  const board = await requireBoard(ctx, boardId);
  const dataset = await loadDataset(boardId);
  if (!dataset) throw new UnknownBoardError();
  return { board, dataset };
}
