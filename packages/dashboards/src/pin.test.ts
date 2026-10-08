import { auditLog, dashboards } from '@agile/db';
import { discoverBoards, listBoards, setBoardSelection } from '@agile/sync';
import { owner, startSyncHarness } from '@agile/sync/testing';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PINNED_DASHBOARD_NAME, pinWidget, removeWidget, updateWidget } from './pin';
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

  it('returns the widget already pinned for the same metric, chart and params', async () => {
    const [before] = await listDashboards(h.db, 'org_a', me.userId, boardId);
    const count = before?.widgets.length ?? 0;
    const pinnedAudits = async () =>
      (
        await h.rawDb
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(eq(auditLog.action, 'dashboard.widget_pinned'))
      ).length;
    const audits = await pinnedAudits();
    // Defaults filled in and keys in another order are still the same widget.
    const again = await pinWidget(h.db, me, {
      boardId,
      widget: { metric: 'cycle_time', chart: 'table', params: { percentile: 85, windowDays: 90 } },
      via: 'user',
    });
    if (!again.ok) throw new Error('pin failed');
    expect(again.alreadyPinned).toBe(true);
    expect(again.widget).toMatchObject({ metric: 'cycle_time', title: 'Team X cycle time' });
    expect(again.widget.id).toBe(before?.widgets[0]?.id);
    expect(await pinnedAudits()).toBe(audits);

    const other = await pinWidget(h.db, me, {
      boardId,
      widget: { metric: 'cycle_time', chart: 'table', params: { percentile: 95 } },
      via: 'user',
    });
    expect(other).toMatchObject({ ok: true, alreadyPinned: false });

    // Concurrent identical pins add it once.
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        pinWidget(h.db, me, { boardId, widget: { metric: 'wip', chart: 'kpi' }, via: 'user' }),
      ),
    );
    expect(results.filter((r) => r.ok && !r.alreadyPinned).length).toBe(1);
    expect(new Set(results.map((r) => (r.ok ? r.widget.id : null))).size).toBe(1);
    const [after] = await listDashboards(h.db, 'org_a', me.userId, boardId);
    expect(after?.widgets.length).toBe(count + 2);
  });

  it('keeps one Pinned dashboard under concurrent pins, and at most 40 widgets', async () => {
    const lead = (days: number) => ({
      metric: 'forecast_how_many',
      chart: 'table',
      params: { days },
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        pinWidget(h.db, me, { boardId, widget: lead(i + 1), via: 'assistant' }),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const rows = await h.rawDb.select().from(dashboards).where(eq(dashboards.kind, 'custom'));
    expect(rows.length).toBe(1);
    const left = 40 - (rows[0]?.widgets.length ?? 0);
    for (let i = 0; i < left; i++) {
      await pinWidget(h.db, me, { boardId, widget: lead(100 + i), via: 'user' });
    }
    expect(await pinWidget(h.db, me, { boardId, widget: lead(300), via: 'user' })).toEqual({
      ok: false,
      code: 'dashboard_full',
    });
    // A widget already there is still returned on a full dashboard.
    expect(await pinWidget(h.db, me, { boardId, widget: lead(1), via: 'user' })).toMatchObject({
      ok: true,
      alreadyPinned: true,
    });
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

  it('pins a query: its title by default, its chart must be its display', async () => {
    const query = {
      title: 'Bugs by assignee',
      groupBy: ['assignee'],
      display: 'bar',
      filter: { types: ['Bug'] },
    };
    const pinned = await pinWidget(h.db, me, {
      boardId,
      widget: { metric: 'query', chart: 'bar', params: query },
      via: 'user',
    });
    if (!pinned.ok) throw new Error('pin failed');
    expect(pinned.widget).toMatchObject({
      metric: 'query',
      chart: 'bar',
      title: 'Bugs by assignee',
    });
    expect(
      await pinWidget(h.db, me, {
        boardId,
        widget: { metric: 'query', chart: 'pie', params: query },
        via: 'user',
      }),
    ).toEqual({ ok: false, code: 'invalid_widget', issues: ['chart'] });
    expect(
      await pinWidget(h.db, me, {
        boardId,
        widget: { metric: 'query', chart: 'bar', params: { ...query, jql: 'x' } },
        via: 'user',
      }),
    ).toMatchObject({ ok: false, code: 'invalid_widget' });
  });

  it("renames a widget and switches its chart, on the user's own dashboard only", async () => {
    const [pinned] = await listDashboards(h.db, 'org_a', me.userId, boardId);
    const cycle = pinned?.widgets.find(
      (w) => w.metric === 'cycle_time' && w.params.percentile === 95,
    );
    if (!pinned || !cycle) throw new Error('nothing pinned');
    const update = (changes: { title?: string | null; chart?: string }, who = me, id = cycle.id) =>
      updateWidget(h.db, who, pinned.id, id, changes);

    expect(await update({ title: 'x' }, { orgId: 'org_a', userId: 'user_other' })).toEqual({
      ok: false,
      code: 'not_found',
    });
    expect(await update({ title: 'x' }, { orgId: 'org_b', userId: me.userId })).toEqual({
      ok: false,
      code: 'not_found',
    });
    expect(await update({ title: 'x' }, me, 'no-such-widget')).toEqual({
      ok: false,
      code: 'not_found',
    });
    expect(await updateWidget(h.db, me, 'not-a-uuid', cycle.id, { title: 'x' })).toEqual({
      ok: false,
      code: 'not_found',
    });

    expect(await update({ title: '  P95 cycle time ', chart: 'kpi' })).toMatchObject({
      ok: true,
      widget: { id: cycle.id, title: 'P95 cycle time', chart: 'kpi', params: { percentile: 95 } },
    });
    expect(await update({ chart: 'bar' })).toEqual({ ok: false, code: 'invalid_widget' });
    expect(await update({ title: 'a'.repeat(81) })).toEqual({ ok: false, code: 'invalid_widget' });
    expect(await update({ title: 'bad' })).toEqual({ ok: false, code: 'invalid_widget' });
    const cleared = await update({ title: null });
    if (!cleared.ok) throw new Error('update failed');
    expect(cleared.widget).not.toHaveProperty('title');
    const [after] = await listDashboards(h.db, 'org_a', me.userId, boardId);
    expect(after?.widgets.find((w) => w.id === cycle.id)).toEqual(cleared.widget);
    expect(after?.widgets.map((w) => w.id)).toEqual(pinned.widgets.map((w) => w.id));

    // A query switches to another display its query allows; its own title is the default.
    const query = pinned.widgets.find((w) => w.metric === 'query');
    if (!query) throw new Error('no query widget');
    expect(await update({ chart: 'pie', title: 'Bugs' }, me, query.id)).toMatchObject({
      ok: true,
      widget: { chart: 'pie', title: 'Bugs', params: { display: 'pie' } },
    });
    expect(await update({ chart: 'line' }, me, query.id)).toEqual({
      ok: false,
      code: 'invalid_widget',
    });
    expect(await update({ title: null }, me, query.id)).toMatchObject({
      ok: true,
      widget: { title: 'Bugs by assignee' },
    });

    const audit = await h.rawDb
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.action, 'dashboard.widget_updated'));
    expect(audit).toContainEqual({
      metadata: { widgetId: cycle.id, renamed: true, chart: 'kpi' },
    });
    expect(audit.length).toBe(4);
  });
});

describe('pinned widgets: concurrency and stored data', () => {
  let h: Awaited<ReturnType<typeof startSyncHarness>>;
  let boardId = '';
  const me = { orgId: 'org_a', userId: 'user_race' };
  // Each call a different widget: pinning the same one twice returns the first.
  let n = 0;
  const next = () => ({ metric: 'forecast_how_many', chart: 'table', params: { days: ++n } });

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
      const r = await pinWidget(h.db, me, { boardId, widget: next(), via: 'user' });
      if (!r.ok) throw new Error('prefill failed');
    }
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        pinWidget(h.db, me, { boardId, widget: next(), via: 'user' }),
      ),
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
      pinWidget(h.db, me, { boardId, widget: next(), via: 'user' }),
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
      pinWidget(h.db, me, { boardId, widget: next(), via: 'user' }),
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
    const pinned = await pinWidget(h.db, me, { boardId, widget: next(), via: 'user' });
    if (!pinned.ok) throw new Error('pin failed');
    expect((await dashboardRow()).widgets).toEqual([legacy, pinned.widget]);
    expect(await removeWidget(h.db, me, row.id, pinned.widget.id)).toEqual({ ok: true });
    expect((await dashboardRow()).widgets).toEqual([legacy]);
  });
});
