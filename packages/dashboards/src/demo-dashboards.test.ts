import { dashboards } from '@agile/db';
import { discoverBoards, listBoards, runSync, setBoardSelection } from '@agile/sync';
import { NOW, owner, startSyncHarness } from '@agile/sync/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeWidget } from './compute';
import { loadBoardDataset } from './dataset';
import { kanbanLayout, scrumLayout } from './layouts';
import { ensureDefaultDashboards, listDashboards, saveDashboardWidgets } from './store';
import type { WidgetData } from './widget-data';

// The demo dataset is what e2e and local review show; these are the numbers the e2e test checks.
describe('default dashboards on the synced demo data', () => {
  let h: Awaited<ReturnType<typeof startSyncHarness>>;
  let scrumId = '';
  let kanbanId = '';
  const kpis = (widgets: { id: string }[], data: WidgetData[]) =>
    Object.fromEntries(
      widgets.flatMap((w, i) => {
        const d = data[i];
        return d?.kind === 'kpi' ? [[w.id, d.value]] : [];
      }),
    );

  beforeAll(async () => {
    h = await startSyncHarness();
    const connectionId = await h.connect();
    await discoverBoards(h.deps, owner(), connectionId);
    const boards = await listBoards(h.deps, 'org_a', connectionId);
    await setBoardSelection(
      h.deps,
      owner(),
      connectionId,
      boards.map((b) => b.id),
    );
    await runSync(h.deps, { orgId: 'org_a', connectionId, trigger: 'manual' });
    scrumId = boards.find((b) => b.type === 'scrum')?.id ?? '';
    kanbanId = boards.find((b) => b.type === 'kanban')?.id ?? '';
  });
  afterAll(async () => h?.stop());

  it('Scrum KPIs: velocity 19, say/do 95%, 2 pts added, 1 carried over', async () => {
    const ds = await loadBoardDataset(h.db, 'org_a', scrumId);
    if (!ds) throw new Error('no dataset');
    const layout = scrumLayout();
    const data = layout.map((w) => computeWidget(w, ds, NOW));
    expect(kpis(layout, data)).toEqual({
      'avg-velocity': 19,
      'say-do': 0.95,
      'scope-added': 2,
      'carry-over': 1,
    });
    const velocity = data[layout.findIndex((w) => w.id === 'velocity')];
    expect(velocity).toMatchObject({
      kind: 'series',
      rows: [
        { sprint: 'DEMO Sprint 1', committed: 20, completed: 19 },
        { sprint: 'DEMO Sprint 2', committed: 20, completed: 19 },
        { sprint: 'DEMO Sprint 3', committed: 20, completed: 19 },
      ],
    });
    const burndown = data[layout.findIndex((w) => w.id === 'burndown')];
    expect(burndown?.kind === 'series' && burndown.rows[0]).toMatchObject({
      remaining: 20,
      ideal: 20,
    });
  });

  it('Flow KPIs: 3 per week, cycle time p85 8 days, WIP 4, flow efficiency 83%', async () => {
    const ds = await loadBoardDataset(h.db, 'org_a', kanbanId);
    if (!ds) throw new Error('no dataset');
    const layout = kanbanLayout();
    const data = layout.map((w) => computeWidget(w, ds, NOW));
    expect(kpis(layout, data)).toEqual({
      'throughput-rate': 3,
      'cycle-time': 8,
      wip: 4,
      'flow-efficiency': 0.8261,
    });
    for (const id of ['throughput', 'cfd', 'aging-wip', 'forecast-how-many', 'forecast-when']) {
      expect(data[layout.findIndex((w) => w.id === id)]?.kind).not.toBe('empty');
    }
  });

  it('creates default dashboards once per user and board', async () => {
    await Promise.all([
      ensureDefaultDashboards(h.db, 'org_a', 'user_1', { id: scrumId, type: 'scrum' }),
      ensureDefaultDashboards(h.db, 'org_a', 'user_1', { id: scrumId, type: 'scrum' }),
    ]);
    await ensureDefaultDashboards(h.db, 'org_a', 'user_1', { id: kanbanId, type: 'kanban' });
    expect((await listDashboards(h.db, 'org_a', 'user_1', scrumId)).map((d) => d.kind)).toEqual([
      'scrum',
      'kanban',
    ]);
    expect((await listDashboards(h.db, 'org_a', 'user_1', kanbanId)).map((d) => d.kind)).toEqual([
      'kanban',
    ]);
    expect(await listDashboards(h.db, 'org_a', 'user_2', scrumId)).toEqual([]);
    expect(await listDashboards(h.db, 'org_b', 'user_1', scrumId)).toEqual([]);
  });

  it("never seeds dashboards on another organisation's board", async () => {
    await ensureDefaultDashboards(h.db, 'org_b', 'user_b', { id: scrumId, type: 'scrum' });
    expect(await h.rawDb.select().from(dashboards).where(eq(dashboards.userId, 'user_b'))).toEqual(
      [],
    );
  });

  it('only stores valid widgets', async () => {
    const [dash] = await listDashboards(h.db, 'org_a', 'user_1', kanbanId);
    const id = dash?.id ?? '';
    expect(
      await saveDashboardWidgets(h.db, 'org_a', 'user_1', id, [{ id: 'x', metric: 'nope' }]),
    ).toEqual({
      ok: false,
      code: 'invalid_widget',
    });
    expect(
      await saveDashboardWidgets(h.db, 'org_a', 'user_2', id, [
        { id: 'w', metric: 'wip', chart: 'kpi' },
      ]),
    ).toEqual({ ok: false, code: 'not_found' });
    expect(
      await saveDashboardWidgets(h.db, 'org_a', 'user_1', id, [
        { id: 'w', metric: 'wip', chart: 'kpi' },
      ]),
    ).toEqual({ ok: true });
    expect((await listDashboards(h.db, 'org_a', 'user_1', kanbanId))[0]?.widgets).toEqual([
      { id: 'w', metric: 'wip', chart: 'kpi', params: {} },
    ]);
  });
});
