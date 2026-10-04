import { dashboards, jiraBoardSprints, jiraBoards, jiraSprints } from '@agile/db';
import { discoverBoards, listBoards, runSync, setBoardSelection } from '@agile/sync';
import { NOW, owner, startSyncHarness } from '@agile/sync/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeWidget } from './compute';
import { loadBoardDataset } from './dataset';
import { defaultDashboards, kanbanLayout, scrumLayout } from './layouts';
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

  it('seeds layouts by the stored board type, not the caller-supplied one', async () => {
    await ensureDefaultDashboards(h.db, 'org_a', 'user_3', { id: kanbanId, type: 'scrum' });
    expect((await listDashboards(h.db, 'org_a', 'user_3', kanbanId)).map((d) => d.kind)).toEqual([
      'kanban',
    ]);
  });

  it('counts issues, never seconds, on a board that estimates with time tracking', async () => {
    const [board] = await h.rawDb.select().from(jiraBoards).where(eq(jiraBoards.id, scrumId));
    try {
      for (const field of ['timeoriginalestimate', 'aggregatetimeestimate']) {
        await h.rawDb
          .update(jiraBoards)
          .set({ estimationFieldId: field })
          .where(eq(jiraBoards.id, scrumId));
        const ds = await loadBoardDataset(h.db, 'org_a', scrumId);
        expect(ds?.hasEstimates).toBe(false);
        const spec = scrumLayout().find((w) => w.id === 'avg-velocity');
        if (!spec || !ds) throw new Error('fixture');
        expect(computeWidget(spec, ds, NOW)).toMatchObject({ kind: 'kpi', format: 'issues' });
      }
    } finally {
      await h.rawDb
        .update(jiraBoards)
        .set({ estimationFieldId: board?.estimationFieldId ?? null })
        .where(eq(jiraBoards.id, scrumId));
    }
    expect((await loadBoardDataset(h.db, 'org_a', scrumId))?.hasEstimates).toBe(true);
  });

  it('gives team-managed boards the Scrum layouts only when they have sprints', async () => {
    expect(defaultDashboards('simple', true).map((d) => d.kind)).toEqual(['scrum', 'kanban']);
    expect(defaultDashboards('simple', false).map((d) => d.kind)).toEqual(['kanban']);
    const [scrumBoard] = await h.rawDb.select().from(jiraBoards).where(eq(jiraBoards.id, scrumId));
    if (!scrumBoard) throw new Error('fixture');
    const team = async (jiraBoardId: number) => {
      const [b] = await h.rawDb
        .insert(jiraBoards)
        .values({
          orgId: 'org_a',
          connectionId: scrumBoard.connectionId,
          jiraBoardId,
          name: `TEAM ${jiraBoardId}`,
          type: 'simple',
          selected: true,
        })
        .returning();
      return b?.id ?? '';
    };
    const withSprints = await team(901);
    const withoutSprints = await team(902);
    const [sprint] = await h.rawDb.select().from(jiraSprints).limit(1);
    await h.rawDb
      .insert(jiraBoardSprints)
      .values({ orgId: 'org_a', boardId: withSprints, sprintId: sprint?.id ?? '' });
    await ensureDefaultDashboards(h.db, 'org_a', 'user_t', { id: withSprints });
    await ensureDefaultDashboards(h.db, 'org_a', 'user_t', { id: withoutSprints });
    expect((await listDashboards(h.db, 'org_a', 'user_t', withSprints)).map((d) => d.kind)).toEqual(
      ['scrum', 'kanban'],
    );
    expect(
      (await listDashboards(h.db, 'org_a', 'user_t', withoutSprints)).map((d) => d.kind),
    ).toEqual(['kanban']);
  });

  it('rejects duplicate or malformed widget ids', async () => {
    const [dash] = await listDashboards(h.db, 'org_a', 'user_1', kanbanId);
    const id = dash?.id ?? '';
    const w = { metric: 'wip', chart: 'kpi' };
    for (const widgets of [
      [
        { id: 'a', ...w },
        { id: 'a', ...w },
      ],
      [{ id: 'a b', ...w }],
    ]) {
      expect(await saveDashboardWidgets(h.db, 'org_a', 'user_1', id, widgets)).toEqual({
        ok: false,
        code: 'invalid_widget',
      });
    }
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
