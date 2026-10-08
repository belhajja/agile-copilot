import { randomBytes } from 'node:crypto';
import { recordAudit } from '@agile/connections';
import { type Db, dashboards, isUuid, jiraBoards, withOrg } from '@agile/db';
import { and, eq, sql } from 'drizzle-orm';
import { chartOptions, parseWidgets, type WidgetSpec, widgetSpecSchema } from './widget-spec';

const MAX_WIDGETS = 40;

/** The custom dashboard that collects widgets pinned from the assistant (one per user and board). */
export const PINNED_DASHBOARD_NAME = 'Pinned';

export interface WidgetOwner {
  orgId: string;
  userId: string;
}

export type PinFailure = {
  ok: false;
  code: 'invalid_widget' | 'unknown_board' | 'dashboard_full';
  /** Which fields of the spec were refused (paths only, for the model to fix its call). */
  issues?: string[];
};

/** Why a widget could not be removed (no such dashboard of the user's, or no such widget). */
export type RemoveFailure = { ok: false; code: 'not_found' };

/** Stable JSON (sorted keys), so equal params compare equal whatever their key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Same metric, chart and (defaulted) params: pinning it again would show the same thing. */
function sameWidget(stored: unknown, widget: WidgetSpec): boolean {
  if (!stored || typeof stored !== 'object') return false;
  const s = stored as { metric?: unknown; chart?: unknown; params?: unknown };
  return (
    s.metric === widget.metric &&
    s.chart === widget.chart &&
    canonical(s.params ?? {}) === canonical(widget.params)
  );
}

/**
 * Adds a widget to the user's "Pinned" dashboard of a board (created on first use). The spec is
 * data from the model: it is validated against the fixed catalog, gets a server-made id, and only
 * ever lands on the caller's own dashboard of a board selected in their workspace. Not a Jira
 * write, so no approval: it is audited and removable in one click. Pinning the same metric and
 * params again returns the widget already there (`alreadyPinned`) instead of adding a copy.
 */
export async function pinWidget(
  db: Db,
  owner: WidgetOwner,
  input: { boardId: string; widget: Record<string, unknown>; via: 'assistant' | 'user' },
): Promise<
  { ok: true; dashboardId: string; widget: WidgetSpec; alreadyPinned: boolean } | PinFailure
> {
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
  let widget = parsed.data;
  if (widget.metric === 'query') {
    // The query decides the display; a chart that says otherwise is a mistake, not a choice.
    if (widget.chart !== widget.params.display)
      return { ok: false, code: 'invalid_widget', issues: ['chart'] };
    widget = { ...widget, title: widget.title ?? widget.params.title };
  }
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
      .where(mine)
      .for('update');
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
    // Stored widgets are kept as they are (even ones that no longer validate): never dropped on write.
    const stored: unknown[] = Array.isArray(pinned.widgets) ? pinned.widgets : [];
    const existing = stored.find((w) => sameWidget(w, widget));
    if (existing) {
      return {
        ok: true,
        dashboardId: pinned.id,
        widget: existing as WidgetSpec,
        alreadyPinned: true,
      } as const;
    }
    if (stored.length >= MAX_WIDGETS) return { ok: false, code: 'dashboard_full' } as const;
    await tx
      .update(dashboards)
      .set({ widgets: [...stored, widget] as WidgetSpec[] })
      .where(eq(dashboards.id, pinned.id));
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
    return { ok: true, dashboardId: pinned.id, widget, alreadyPinned: false } as const;
  });
}

/** Removes a widget from one of the user's dashboards. */
export async function removeWidget(
  db: Db,
  owner: WidgetOwner,
  dashboardId: string,
  widgetId: string,
): Promise<{ ok: true } | RemoveFailure> {
  if (!isUuid(dashboardId)) return { ok: false, code: 'not_found' };
  return withOrg(db, owner.orgId, async (tx) => {
    const [row] = await tx
      .select({ widgets: dashboards.widgets })
      .from(dashboards)
      .where(and(eq(dashboards.id, dashboardId), eq(dashboards.userId, owner.userId)))
      .for('update');
    if (!row) return { ok: false, code: 'not_found' } as const;
    // Owner-only; allowed on default dashboards too (the UI offers removal on Pinned only).
    // Unparseable stored widgets are kept untouched.
    const widgets: unknown[] = Array.isArray(row.widgets) ? row.widgets : [];
    const kept = widgets.filter((w) => (w as { id?: unknown } | null)?.id !== widgetId);
    if (kept.length === widgets.length) return { ok: false, code: 'not_found' } as const;
    await tx
      .update(dashboards)
      .set({ widgets: kept as WidgetSpec[] })
      .where(eq(dashboards.id, dashboardId));
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

export type UpdateFailure = { ok: false; code: 'not_found' | 'invalid_widget' };

/**
 * Renames a widget of one of the user's dashboards and/or switches it to another of its charts
 * (for a query, another display its query allows). `title: null` goes back to the default title.
 */
export async function updateWidget(
  db: Db,
  owner: WidgetOwner,
  dashboardId: string,
  widgetId: string,
  changes: { title?: string | null; chart?: string },
): Promise<{ ok: true; widget: WidgetSpec } | UpdateFailure> {
  if (!isUuid(dashboardId)) return { ok: false, code: 'not_found' };
  return withOrg(db, owner.orgId, async (tx) => {
    const [row] = await tx
      .select({ widgets: dashboards.widgets })
      .from(dashboards)
      .where(and(eq(dashboards.id, dashboardId), eq(dashboards.userId, owner.userId)))
      .for('update');
    if (!row) return { ok: false, code: 'not_found' } as const;
    const widgets: unknown[] = Array.isArray(row.widgets) ? row.widgets : [];
    const index = widgets.findIndex((w) => (w as { id?: unknown } | null)?.id === widgetId);
    if (index === -1) return { ok: false, code: 'not_found' } as const;
    // A stored widget that no longer validates is left as it is.
    const [current] = parseWidgets([widgets[index]]);
    if (!current) return { ok: false, code: 'invalid_widget' } as const;

    let next: Record<string, unknown> = { ...current };
    if (changes.title !== undefined) {
      const fallback =
        current.metric === 'query' && !('unavailable' in current.params)
          ? current.params.title
          : undefined;
      next.title = changes.title?.trim() || fallback;
      if (next.title === undefined) delete next.title;
    }
    if (changes.chart !== undefined && changes.chart !== current.chart) {
      if (!chartOptions(current).includes(changes.chart as WidgetSpec['chart']))
        return { ok: false, code: 'invalid_widget' } as const;
      next = {
        ...next,
        chart: changes.chart,
        ...(current.metric === 'query'
          ? { params: { ...current.params, display: changes.chart } }
          : {}),
      };
    }
    // An unavailable query only gets a new title; anything else is validated as a new pin is.
    let updated: WidgetSpec | undefined;
    if (current.metric === 'query' && 'unavailable' in current.params) {
      [updated] = parseWidgets([next]);
    } else {
      const parsed = widgetSpecSchema.safeParse(next);
      updated = parsed.success ? parsed.data : undefined;
    }
    if (!updated) return { ok: false, code: 'invalid_widget' } as const;
    await tx
      .update(dashboards)
      .set({ widgets: widgets.map((w, i) => (i === index ? updated : w)) as WidgetSpec[] })
      .where(eq(dashboards.id, dashboardId));
    await recordAudit(tx, {
      orgId: owner.orgId,
      actorUserId: owner.userId,
      action: 'dashboard.widget_updated',
      targetType: 'dashboard',
      targetId: dashboardId,
      metadata: {
        widgetId,
        renamed: changes.title !== undefined,
        ...(updated.chart !== current.chart ? { chart: updated.chart } : {}),
      },
    });
    return { ok: true, widget: updated } as const;
  });
}
