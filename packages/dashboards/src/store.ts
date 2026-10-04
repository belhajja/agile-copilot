import { type Db, dashboards, jiraBoardSprints, jiraBoards, withOrg } from '@agile/db';
import { and, asc, eq } from 'drizzle-orm';
import { defaultDashboards } from './layouts';
import { parseWidgets, type WidgetSpec, widgetListSchema } from './widget-spec';

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
  /** `type` is ignored: the layouts follow the stored board's type (and whether it has sprints). */
  board: { id: string; type?: 'scrum' | 'kanban' | 'simple' },
): Promise<void> {
  await withOrg(db, orgId, async (tx) => {
    // A foreign key check ignores RLS, so confirm the board belongs to this tenant first.
    const [own] = await tx
      .select({ id: jiraBoards.id, type: jiraBoards.type })
      .from(jiraBoards)
      .where(and(eq(jiraBoards.id, board.id), eq(jiraBoards.orgId, orgId)));
    if (!own) return;
    const [sprint] = await tx
      .select({ id: jiraBoardSprints.sprintId })
      .from(jiraBoardSprints)
      .where(eq(jiraBoardSprints.boardId, own.id))
      .limit(1);
    await tx
      .insert(dashboards)
      .values(
        defaultDashboards(own.type, sprint !== undefined).map((d, position) => ({
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
  const parsed = widgetListSchema.safeParse(widgets);
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
