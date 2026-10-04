import { jiraBoardIssues, jiraBoards, jiraSyncRuns, jiraSyncStates } from '@agile/db';
import {
  createJiraDataSource,
  type DataSourceOptions,
  type JiraCredentialsInput,
  type JiraDataSource,
  JiraPaginationError,
} from '@agile/jira';
import { and, count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverBoards, listBoards, setBoardSelection } from './boards';
import type { SyncDeps } from './deps';
import { runSync } from './run-sync';
import { NOW, owner, startSyncHarness } from './test-harness';

const min = (n: number) => new Date(NOW.getTime() + n * 60_000);

describe('runSync fix round: windows, new boards, recovery, failures', () => {
  let h: Awaited<ReturnType<typeof startSyncHarness>>;
  let n = 0;

  beforeAll(async () => {
    h = await startSyncHarness({ maxPageSize: 10 });
  });
  afterAll(async () => h?.stop());

  /** A fresh connection with boards discovered; `select` picks boards by name. */
  const setup = async (select: string[] | 'all') => {
    const org = `org_f${++n}`;
    const connectionId = await h.connect(owner(org), 'Jira');
    await discoverBoards(h.deps, owner(org), connectionId);
    const choose = async (names: string[] | 'all') => {
      const boards = await listBoards(h.deps, org, connectionId);
      await setBoardSelection(
        h.deps,
        owner(org),
        connectionId,
        boards.filter((b) => names === 'all' || names.includes(b.name)).map((b) => b.id),
      );
    };
    await choose(select);
    return {
      org,
      connectionId,
      choose,
      job: { orgId: org, connectionId, trigger: 'manual' as const },
    };
  };
  const stateOf = async (connectionId: string) => {
    const [s] = await h.rawDb
      .select()
      .from(jiraSyncStates)
      .where(eq(jiraSyncStates.connectionId, connectionId));
    return s;
  };
  const membership = async (connectionId: string, name?: string) => {
    const [row] = await h.rawDb
      .select({ n: count() })
      .from(jiraBoardIssues)
      .innerJoin(jiraBoards, eq(jiraBoards.id, jiraBoardIssues.boardId))
      .where(
        and(
          eq(jiraBoards.connectionId, connectionId),
          name ? eq(jiraBoards.name, name) : undefined,
        ),
      );
    return row?.n ?? 0;
  };
  const wrap =
    (patch: (real: JiraDataSource) => Partial<JiraDataSource>): SyncDeps['createSource'] =>
    (creds: JiraCredentialsInput, opts: DataSourceOptions) => {
      const real = createJiraDataSource(creds, opts);
      return { ...real, ...patch(real) };
    };

  it('computes the relative window when the search is built, not at run start', async () => {
    const { job, connectionId } = await setup('all');
    expect(await runSync(h.deps, job)).toMatchObject({ ok: true, mode: 'full' });
    h.mock.requests.length = 0;
    let calls = 0;
    // First clock read = run start (+30 min); every later read is another 30 minutes on.
    const now = () => min(calls++ === 0 ? 30 : 60);
    expect(await runSync({ ...h.deps, now }, job)).toMatchObject({ ok: true, mode: 'incremental' });
    const searches = h.mock.requests.filter((q) => q.path.endsWith('/rest/api/2/search'));
    expect(searches.length).toBeGreaterThan(0);
    for (const s of searches) {
      expect(new URLSearchParams(s.search).get('jql')).toMatch(/AND updated >= "-75m" ORDER BY/);
    }
    expect((await stateOf(connectionId))?.watermark).toEqual(min(30));
  });

  it('reads a board selected after the first sync completely, even in incremental mode', async () => {
    const { job, connectionId, choose } = await setup(['DEMO Scrum']);
    expect(await runSync(h.deps, job)).toMatchObject({ ok: true, mode: 'full', boards: 1 });
    expect(await membership(connectionId, 'OPS Kanban')).toBe(0);
    await choose('all');
    const r = await runSync({ ...h.deps, now: () => min(30) }, job);
    expect(r).toMatchObject({ ok: true, mode: 'incremental', boards: 2 });
    expect(await membership(connectionId, 'OPS Kanban')).toBe(31);
    expect(await membership(connectionId, 'DEMO Scrum')).toBe(25);
  });

  it('takes over a stale lease and marks the orphaned run as abandoned', async () => {
    const { job, connectionId, org } = await setup('all');
    expect(await runSync(h.deps, job)).toMatchObject({ ok: true });
    await h.rawDb
      .update(jiraSyncStates)
      .set({ status: 'running', lastStartedAt: sql`now() - interval '2 hours'` })
      .where(eq(jiraSyncStates.connectionId, connectionId));
    const [orphan] = await h.rawDb
      .insert(jiraSyncRuns)
      .values({ orgId: org, connectionId, trigger: 'schedule', mode: 'incremental' })
      .returning();
    expect(await runSync({ ...h.deps, now: () => min(30) }, job)).toMatchObject({ ok: true });
    const [old] = await h.rawDb
      .select()
      .from(jiraSyncRuns)
      .where(eq(jiraSyncRuns.id, orphan?.id ?? ''));
    expect(old).toMatchObject({ status: 'error', error: 'abandoned' });
    expect(old?.finishedAt).not.toBeNull();
  });

  it('does not take over a fresh lease (clock skew in deps.now is irrelevant)', async () => {
    const { job, connectionId } = await setup('all');
    await runSync(h.deps, job);
    await h.rawDb
      .update(jiraSyncStates)
      .set({ status: 'running', lastStartedAt: sql`now() - interval '5 minutes'` })
      .where(eq(jiraSyncStates.connectionId, connectionId));
    const far = new Date(Date.now() + 10 * 3_600_000);
    expect(await runSync({ ...h.deps, now: () => far }, job)).toEqual({
      ok: false,
      code: 'already_running',
    });
  });

  it('refreshes the lease while boards are being read', async () => {
    const { job, connectionId, org } = await setup('all');
    await h.rawDb.insert(jiraSyncStates).values({ orgId: org, connectionId }).onConflictDoNothing();
    const seen: Date[] = [];
    const source = wrap((real) => ({
      getBoardConfig: async (id) => {
        const s = await stateOf(connectionId);
        if (s?.lastStartedAt) seen.push(s.lastStartedAt);
        await h.rawDb
          .update(jiraSyncStates)
          .set({ lastStartedAt: sql`now() - interval '50 minutes'` })
          .where(eq(jiraSyncStates.connectionId, connectionId));
        return real.getBoardConfig(id);
      },
    }));
    expect(await runSync({ ...h.deps, createSource: source }, job)).toMatchObject({ ok: true });
    // After board 1 the heartbeat moved the lease back to "now": board 2 saw a recent value.
    expect(seen).toHaveLength(2);
    expect(Date.now() - (seen[1]?.getTime() ?? 0)).toBeLessThan(5 * 60_000);
  });

  it('maps hostile paging on page 2 of a full run to jira_paging without pruning', async () => {
    const { job, connectionId } = await setup('all');
    await runSync(h.deps, job);
    const before = await stateOf(connectionId);
    const members = await membership(connectionId);
    const leaving = h.dataset.issues.find((i) => i.key === 'OPS-2');
    if (!leaving) throw new Error('fixture');
    const filters = leaving.filterIds;
    leaving.filterIds = [];
    await h.rawDb
      .update(jiraBoards)
      .set({ lastFullSyncAt: new Date(NOW.getTime() - 25 * 3_600_000) })
      .where(eq(jiraBoards.connectionId, connectionId));
    const before2 = await stateOf(connectionId);
    const source = wrap((real) => ({
      searchIssues: async function* (jql, fields) {
        let page = 0;
        for await (const p of real.searchIssues(jql, fields)) {
          if (++page === 2) throw new JiraPaginationError('repeated_page');
          yield p;
        }
      },
    }));
    try {
      const r = await runSync({ ...h.deps, now: () => min(60), createSource: source }, job);
      expect(r).toEqual({ ok: false, code: 'jira_paging' });
    } finally {
      leaving.filterIds = filters;
    }
    const after = await stateOf(connectionId);
    expect(after).toMatchObject({ status: 'error', lastError: 'jira_paging' });
    expect(after?.watermark).toEqual(before?.watermark);
    expect(after?.lastFullSyncAt).toEqual(before2?.lastFullSyncAt);
    expect(await membership(connectionId)).toBe(members);
  });

  it('one failing board does not stop the others, and the run reports its code', async () => {
    const { job, connectionId } = await setup('all');
    const source = wrap((real) => ({
      searchIssues: (jql, fields) => {
        if (jql.startsWith('filter = 101')) {
          throw Object.assign(new Error('filter gone'), { status: 400 });
        }
        return real.searchIssues(jql, fields);
      },
    }));
    const r = await runSync({ ...h.deps, createSource: source }, job);
    expect(r).toEqual({ ok: false, code: 'board_query_rejected' });
    expect(await membership(connectionId, 'OPS Kanban')).toBe(31);
    const s = await stateOf(connectionId);
    expect(s).toMatchObject({ status: 'error', lastError: 'board_query_rejected' });
    expect(s?.watermark).toBeNull();
    const [run] = await h.rawDb
      .select()
      .from(jiraSyncRuns)
      .where(eq(jiraSyncRuns.connectionId, connectionId));
    expect(run).toMatchObject({ status: 'error', error: 'board_query_rejected', boardsSynced: 1 });
  });
});
