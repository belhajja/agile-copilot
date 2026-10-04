import { auditLog, dashboards } from '@agile/db';
import { discoverBoards, listBoards, setBoardSelection } from '@agile/sync';
import { owner, startSyncHarness } from '@agile/sync/testing';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PINNED_DASHBOARD_NAME, pinWidget, removeWidget } from './pin';
import { listDashboards } from './store';

describe('pinned widgets (prompt-driven dashboard)', () => {
  let h: Awaited<ReturnType<typeof startSyncHarness>>;
  let boardId = '';
  let unselected = '';
  const me = { orgId: 'org_a', userId: 'user_pat' };

  beforeAll(async () => {
    h = await startSyncHarness();
    const connectionId = await h.connect();
    await discoverBoards(h.deps, owner(), connectionId);
    const boards = await listBoards(h.deps, 'org_a', connectionId);
    boardId = boards[0]?.id ?? '';
    unselected = boards[1]?.id ?? '';
    await setBoardSelection(h.deps, owner(), connectionId, [boardId]);
  });
  afterAll(async () => h?.stop());

  const cycleTime = { metric: 'cycle_time', chart: 'table', title: 'Team X cycle time' };

  it('creates the Pinned dashboard on first use and appends validated widgets with server ids', async () => {
    const first = await pinWidget(h.db, me, { boardId, widget: cycleTime, via: 'assistant' });
    const second = await pinWidget(h.db, me, {
      boardId,
      widget: { metric: 'throughput', chart: 'bar', params: { weeks: 8 }, id: 'model-chosen' },
      via: 'assistant',
    });
    if (!first.ok || !second.ok) throw new Error('pin failed');
    expect(second.dashboardId).toBe(first.dashboardId);
    expect(first.widget).toEqual({
      id: expect.stringMatching(/^w-[0-9a-f]{12}$/),
      metric: 'cycle_time',
      chart: 'table',
      title: 'Team X cycle time',
      params: { windowDays: 90, percentile: 85 },
    });
    expect(second.widget.id).not.toBe('model-chosen');
    const list = await listDashboards(h.db, 'org_a', me.userId, boardId);
    expect(list.map((d) => [d.name, d.kind, d.widgets.map((w) => w.metric)])).toEqual([
      [PINNED_DASHBOARD_NAME, 'custom', ['cycle_time', 'throughput']],
    ]);
    // Another user's dashboards are untouched.
    expect(await listDashboards(h.db, 'org_a', 'user_other', boardId)).toEqual([]);
  });

  it('refuses specs outside the catalog, unknown or unselected boards, other workspaces', async () => {
    expect(
      await pinWidget(h.db, me, {
        boardId,
        widget: { metric: 'cycle_time', chart: 'pie' },
        via: 'assistant',
      }),
    ).toEqual({ ok: false, code: 'invalid_widget', issues: ['chart'] });
    expect(
      await pinWidget(h.db, me, {
        boardId,
        widget: { metric: 'run_sql', chart: 'table' },
        via: 'assistant',
      }),
    ).toMatchObject({ ok: false, code: 'invalid_widget' });
    expect(
      await pinWidget(h.db, me, { boardId: unselected, widget: cycleTime, via: 'assistant' }),
    ).toEqual({ ok: false, code: 'unknown_board' });
    expect(
      await pinWidget(
        h.db,
        { orgId: 'org_b', userId: 'user_x' },
        {
          boardId,
          widget: cycleTime,
          via: 'assistant',
        },
      ),
    ).toEqual({ ok: false, code: 'unknown_board' });
    expect(
      await pinWidget(h.db, me, { boardId: 'not-a-uuid', widget: cycleTime, via: 'assistant' }),
    ).toEqual({ ok: false, code: 'unknown_board' });
  });

  it('keeps one Pinned dashboard under concurrent pins, and at most 40 widgets', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        pinWidget(h.db, me, { boardId, widget: { metric: 'wip', chart: 'kpi' }, via: 'assistant' }),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const rows = await h.rawDb.select().from(dashboards).where(eq(dashboards.kind, 'custom'));
    expect(rows.length).toBe(1);
    const left = 40 - (rows[0]?.widgets.length ?? 0);
    for (let i = 0; i < left; i++) {
      await pinWidget(h.db, me, { boardId, widget: { metric: 'wip', chart: 'kpi' }, via: 'user' });
    }
    expect(
      await pinWidget(h.db, me, { boardId, widget: { metric: 'wip', chart: 'kpi' }, via: 'user' }),
    ).toEqual({ ok: false, code: 'dashboard_full' });
  });

  it("removes a widget from the user's own dashboard only, and audits pins and removals", async () => {
    const [pinned] = await listDashboards(h.db, 'org_a', me.userId, boardId);
    const widget = pinned?.widgets[0];
    if (!pinned || !widget) throw new Error('nothing pinned');
    expect(
      await removeWidget(h.db, { orgId: 'org_a', userId: 'user_other' }, pinned.id, widget.id),
    ).toEqual({
      ok: false,
      code: 'not_found',
    });
    expect(await removeWidget(h.db, me, pinned.id, widget.id)).toEqual({ ok: true });
    expect(await removeWidget(h.db, me, pinned.id, widget.id)).toEqual({
      ok: false,
      code: 'not_found',
    });
    const audit = await h.rawDb
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(like(auditLog.action, 'dashboard.%'));
    expect(audit).toContainEqual({
      action: 'dashboard.widget_pinned',
      metadata: { boardId, metric: 'cycle_time', chart: 'table', via: 'assistant' },
    });
    expect(audit.filter((a) => a.action === 'dashboard.widget_removed')).toEqual([
      { action: 'dashboard.widget_removed', metadata: { widgetId: widget.id } },
    ]);
  });
});
