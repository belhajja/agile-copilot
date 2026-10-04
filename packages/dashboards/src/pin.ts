import { randomBytes } from 'node:crypto';
import { recordAudit } from '@agile/connections';
import { type Db, dashboards, isUuid, jiraBoards, withOrg } from '@agile/db';
import { and, eq, sql } from 'drizzle-orm';
import { parseWidgets, type WidgetSpec, widgetListSchema, widgetSpecSchema } from './widget-spec';

/** The custom dashboard that collects widgets pinned from the assistant (one per user and board). */
export const PINNED_DASHBOARD_NAME = 'Pinned';

export interface WidgetOwner {
  orgId: string;
  userId: string;
}

export type PinFailure = {
  ok: false;
  code: 'invalid_widget' | 'unknown_board' | 'dashboard_full' | 'not_found';
  /** Which fields of the spec were refused (paths only, for the model to fix its call). */
  issues?: string[];
};

/**
 * Adds a widget to the user's "Pinned" dashboard of a board (created on first use). The spec is
 * data from the model: it is validated against the fixed catalog, gets a server-made id, and only
 * ever lands on the caller's own dashboard of a board selected in their workspace. Not a Jira
 * write, so no approval: it is audited and removable in one click.
 */
export async function pinWidget(
  db: Db,
  owner: WidgetOwner,
  input: { boardId: string; widget: Record<string, unknown>; via: 'assistant' | 'user' },
): Promise<{ ok: true; dashboardId: string; widget: WidgetSpec } | PinFailure> {
  const parsed = widgetSpecSchema.safeParse({
    ...input.widget,
    id: `w-${randomBytes(6).toString('hex')}`,
  });
  if (!parsed.success) {
    return {
      ok: false,
      code: 'invalid_widget',
      issues: parsed.error.issues.map((i) => i.path.join('.') || 'widget'),
    };
  }
  if (!isUuid(input.boardId)) return { ok: false, code: 'unknown_board' };
  const widget = parsed.data;
  return withOrg(db, owner.orgId, async (tx) => {
    // A foreign key check ignores RLS: confirm the board is this workspace's, and synced.
    const [board] = await tx
      .select({ id: jiraBoards.id })
      .from(jiraBoards)
      .where(
        and(
          eq(jiraBoards.id, input.boardId),
          eq(jiraBoards.orgId, owner.orgId),
          eq(jiraBoards.selected, true),
        ),
      );
    if (!board) return { ok: false, code: 'unknown_board' } as const;
    // Two pins at once must not create two "Pinned" dashboards.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`pinned:${owner.userId}:${input.boardId}`}))`,
    );
    const mine = and(
      eq(dashboards.userId, owner.userId),
      eq(dashboards.boardId, input.boardId),
      eq(dashboards.kind, 'custom'),
      eq(dashboards.name, PINNED_DASHBOARD_NAME),
    );
    let [pinned] = await tx
      .select({ id: dashboards.id, widgets: dashboards.widgets })
      .from(dashboards)
      .where(mine);
    if (!pinned) {
      [pinned] = await tx
        .insert(dashboards)
        .values({
          orgId: owner.orgId,
          userId: owner.userId,
          boardId: input.boardId,
          name: PINNED_DASHBOARD_NAME,
          kind: 'custom',
          position: 100,
          widgets: [],
        })
        .returning({ id: dashboards.id, widgets: dashboards.widgets });
    }
    if (!pinned) throw new Error('pinned dashboard insert returned nothing');
    const next = widgetListSchema.safeParse([...parseWidgets(pinned.widgets), widget]);
    if (!next.success) return { ok: false, code: 'dashboard_full' } as const;
    await tx.update(dashboards).set({ widgets: next.data }).where(eq(dashboards.id, pinned.id));
    await recordAudit(tx, {
      orgId: owner.orgId,
      actorUserId: owner.userId,
      action: 'dashboard.widget_pinned',
      targetType: 'dashboard',
      targetId: pinned.id,
      metadata: {
        boardId: input.boardId,
        metric: widget.metric,
        chart: widget.chart,
        via: input.via,
      },
    });
    return { ok: true, dashboardId: pinned.id, widget } as const;
  });
}

/** Removes a widget from one of the user's dashboards. */
export async function removeWidget(
  db: Db,
  owner: WidgetOwner,
  dashboardId: string,
  widgetId: string,
): Promise<{ ok: true } | PinFailure> {
  if (!isUuid(dashboardId)) return { ok: false, code: 'not_found' };
  return withOrg(db, owner.orgId, async (tx) => {
    const [row] = await tx
      .select({ widgets: dashboards.widgets })
      .from(dashboards)
      .where(and(eq(dashboards.id, dashboardId), eq(dashboards.userId, owner.userId)))
      .for('update');
    if (!row) return { ok: false, code: 'not_found' } as const;
    const widgets = parseWidgets(row.widgets);
    const kept = widgets.filter((w) => w.id !== widgetId);
    if (kept.length === widgets.length) return { ok: false, code: 'not_found' } as const;
    await tx.update(dashboards).set({ widgets: kept }).where(eq(dashboards.id, dashboardId));
    await recordAudit(tx, {
      orgId: owner.orgId,
      actorUserId: owner.userId,
      action: 'dashboard.widget_removed',
      targetType: 'dashboard',
      targetId: dashboardId,
      metadata: { widgetId },
    });
    return { ok: true } as const;
  });
}
