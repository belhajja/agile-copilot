import { auditLog, dashboards } from '@agile/db';
import { discoverBoards, listBoards, setBoardSelection } from '@agile/sync';
import { owner, startSyncHarness } from '@agile/sync/testing';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PINNED_DASHBOARD_NAME, pinWidget, removeWidget } from './pin';
import { listDashboards, saveDashboardWidgets } from './store';

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
    // Another workspace cannot reach it either.
    expect(
      await removeWidget(h.db, { orgId: 'org_b', userId: me.userId }, pinned.id, widget.id),
    ).toEqual({ ok: false, code: 'not_found' });
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
    expect(
      audit.filter(
        (a) =>
          a.action === 'dashboard.widget_pinned' && (a.metadata as { via?: string }).via === 'user',
      ).length,
    ).toBeGreaterThan(0);
    expect(audit.filter((a) => a.action === 'dashboard.widget_removed')).toEqual([
      { action: 'dashboard.widget_removed', metadata: { widgetId: widget.id } },
    ]);
  });
});

describe('pinned widgets: concurrency and stored data', () => {
  let h: Awaited<ReturnType<typeof startSyncHarness>>;
  let boardId = '';
  const me = { orgId: 'org_a', userId: 'user_race' };
  const kpi = { metric: 'wip', chart: 'kpi' };

  beforeAll(async () => {
    h = await startSyncHarness();
    const connectionId = await h.connect();
    await discoverBoards(h.deps, owner(), connectionId);
    boardId = (await listBoards(h.deps, 'org_a', connectionId))[0]?.id ?? '';
    await setBoardSelection(h.deps, owner(), connectionId, [boardId]);
  });
  afterAll(async () => h?.stop());

  const dashboardRow = async () => {
    const rows = await h.rawDb.select().from(dashboards).where(eq(dashboards.userId, me.userId));
    const row = rows[0];
    if (!row) throw new Error('no dashboard');
    return { id: row.id, widgets: row.widgets as { id: string }[] };
  };

  it('at 39 widgets, three concurrent pins yield exactly one ok and 40 widgets', async () => {
    for (let i = 0; i < 39; i++) {
      const r = await pinWidget(h.db, me, { boardId, widget: kpi, via: 'user' });
      if (!r.ok) throw new Error('prefill failed');
    }
    const results = await Promise.all(
      Array.from({ length: 3 }, () => pinWidget(h.db, me, { boardId, widget: kpi, via: 'user' })),
    );
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok && r.code === 'dashboard_full').length).toBe(2);
    expect((await dashboardRow()).widgets.length).toBe(40);
  });

  it('a concurrent pin and remove never bring the removed widget back', async () => {
    const row = await dashboardRow();
    const target = row.widgets[0];
    const second = row.widgets[1];
    if (!target || !second) throw new Error('missing');
    await removeWidget(h.db, me, row.id, second.id); // make room (39)
    const [, removed] = await Promise.all([
      pinWidget(h.db, me, { boardId, widget: kpi, via: 'user' }),
      removeWidget(h.db, me, row.id, target.id),
    ]);
    expect(removed).toEqual({ ok: true });
    const ids = (await dashboardRow()).widgets.map((w) => w.id);
    expect(ids).not.toContain(target.id);
    expect(ids.length).toBe(39);
  });

  it('a concurrent pin and save keep one consistent list', async () => {
    const row = await dashboardRow();
    const keep = row.widgets.slice(0, 2);
    const [, saved] = await Promise.all([
      pinWidget(h.db, me, { boardId, widget: kpi, via: 'user' }),
      saveDashboardWidgets(h.db, me.orgId, me.userId, row.id, keep),
    ]);
    expect(saved).toEqual({ ok: true });
    const n = (await dashboardRow()).widgets.length;
    expect([2, 3]).toContain(n); // serialised: either order, never a torn write
  });

  it('keeps stored widgets that no longer validate when pinning and removing', async () => {
    const row = await dashboardRow();
    const legacy = { id: 'old-1', metric: 'retired_metric', chart: 'table' };
    await h.rawDb
      .update(dashboards)
      .set({ widgets: [legacy] as never })
      .where(eq(dashboards.id, row.id));
    const pinned = await pinWidget(h.db, me, { boardId, widget: kpi, via: 'user' });
    if (!pinned.ok) throw new Error('pin failed');
    expect((await dashboardRow()).widgets).toEqual([legacy, pinned.widget]);
    expect(await removeWidget(h.db, me, row.id, pinned.widget.id)).toEqual({ ok: true });
    expect((await dashboardRow()).widgets).toEqual([legacy]);
  });
});
