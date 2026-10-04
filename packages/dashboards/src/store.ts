import { type Db, dashboards, jiraBoards, withOrg } from '@agile/db';
import { and, asc, eq } from 'drizzle-orm';
import { defaultDashboards } from './layouts';
import { parseWidgets, type WidgetSpec, widgetSpecSchema } from './widget-spec';

export interface DashboardView {
  id: string;
  name: string;
  kind: 'scrum' | 'kanban' | 'custom';
  widgets: WidgetSpec[];
}

/** Creates the user's default dashboards for a board the first time (idempotent, race-safe). */
export async function ensureDefaultDashboards(
  db: Db,
  orgId: string,
  userId: string,
  board: { id: string; type: 'scrum' | 'kanban' | 'simple' },
): Promise<void> {
  await withOrg(db, orgId, async (tx) => {
    // A foreign key check ignores RLS, so confirm the board belongs to this tenant first.
    const [own] = await tx
      .select({ id: jiraBoards.id })
      .from(jiraBoards)
      .where(and(eq(jiraBoards.id, board.id), eq(jiraBoards.orgId, orgId)));
    if (!own) return;
    await tx
      .insert(dashboards)
      .values(
        defaultDashboards(board.type).map((d, position) => ({
          orgId,
          userId,
          boardId: board.id,
          name: d.name,
          kind: d.kind,
          position,
          widgets: d.widgets,
        })),
      )
      .onConflictDoNothing();
  });
}

export async function listDashboards(
  db: Db,
  orgId: string,
  userId: string,
  boardId: string,
): Promise<DashboardView[]> {
  const rows = await withOrg(db, orgId, (tx) =>
    tx
      .select()
      .from(dashboards)
      .where(and(eq(dashboards.userId, userId), eq(dashboards.boardId, boardId)))
      .orderBy(asc(dashboards.position), asc(dashboards.createdAt)),
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    widgets: parseWidgets(r.widgets),
  }));
}

/** Replaces a dashboard's widgets after validating every spec (Phase 4's agent writes through here). */
export async function saveDashboardWidgets(
  db: Db,
  orgId: string,
  userId: string,
  dashboardId: string,
  widgets: unknown[],
): Promise<{ ok: true } | { ok: false; code: 'invalid_widget' | 'not_found' }> {
  const parsed = widgetSpecSchema.array().max(40).safeParse(widgets);
  if (!parsed.success) return { ok: false, code: 'invalid_widget' };
  const updated = await withOrg(db, orgId, (tx) =>
    tx
      .update(dashboards)
      .set({ widgets: parsed.data })
      .where(and(eq(dashboards.id, dashboardId), eq(dashboards.userId, userId)))
      .returning({ id: dashboards.id }),
  );
  return updated.length > 0 ? { ok: true } : { ok: false, code: 'not_found' };
}
