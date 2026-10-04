import { createJiraConnection } from '@agile/connections';
import {
  jiraBoardSprints,
  jiraBoards,
  jiraStatusMappings,
  jiraSyncRuns,
  jiraSyncStates,
} from '@agile/db';
import {
  createJiraDataSource,
  type DataSourceOptions,
  type JiraCredentialsInput,
  type JiraDataSource,
} from '@agile/jira';
import { and, count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverBoards, listBoards, listStatusMappings, setBoardSelection } from './boards';
import {
  CONNECTION_WIDE_CODES,
  PERMANENT_CODES,
  RETRYABLE_CODES,
  SYNC_FAILURE_CODES,
  type SyncDeps,
} from './deps';
import { handleSyncJob, RetryableSyncError } from './queue';
import { LEASE_MS, runSync } from './run-sync';
import { NOW, owner, startSyncHarness } from './test-harness';

const min = (n: number) => new Date(NOW.getTime() + n * 60_000);

describe('Phase 2 fix wave: interruption, DNS, per-board progress, discovery, team-managed boards', () => {
  let h: Awaited<ReturnType<typeof startSyncHarness>>;
  let n = 0;

  beforeAll(async () => {
    h = await startSyncHarness();
  });
  afterAll(async () => h?.stop());

  const setup = async (select: string[] | 'all' = 'all') => {
    const org = `org_x${++n}`;
    const connectionId = await h.connect(owner(org), 'Jira');
    await discoverBoards(h.deps, owner(org), connectionId);
    const boards = await listBoards(h.deps, org, connectionId);
    await setBoardSelection(
      h.deps,
      owner(org),
      connectionId,
      boards.filter((b) => select === 'all' || select.includes(b.name)).map((b) => b.id),
    );
    return { org, connectionId, job: { orgId: org, connectionId, trigger: 'manual' as const } };
  };
  const stateOf = async (connectionId: string) => {
    const [s] = await h.rawDb
      .select()
      .from(jiraSyncStates)
      .where(eq(jiraSyncStates.connectionId, connectionId));
    return s;
  };
  const boardRow = async (connectionId: string, name: string) => {
    const [b] = await h.rawDb
      .select()
      .from(jiraBoards)
      .where(and(eq(jiraBoards.connectionId, connectionId), eq(jiraBoards.name, name)));
    return b;
  };
  const wrap =
    (patch: (real: JiraDataSource) => Partial<JiraDataSource>): SyncDeps['createSource'] =>
    (creds: JiraCredentialsInput, opts: DataSourceOptions) => {
      const real = createJiraDataSource(creds, opts);
      return { ...real, ...patch(real) };
    };

  describe('I1 interruption and lease', () => {
    it('an aborted run is recorded as interrupted and releases the lease at once', async () => {
      const { job, connectionId } = await setup();
      const abort = new AbortController();
      const source = wrap((real) => ({
        searchIssues: async function* (jql, fields) {
          for await (const page of real.searchIssues(jql, fields)) {
            abort.abort(); // the worker is stopping while page 1 is being stored
            yield page;
          }
        },
      }));
      const r = await runSync({ ...h.deps, createSource: source, signal: abort.signal }, job);
      expect(r).toEqual({ ok: false, code: 'interrupted' });
      expect(await stateOf(connectionId)).toMatchObject({
        status: 'error',
        lastError: 'interrupted',
      });
      const runs = await h.rawDb
        .select()
        .from(jiraSyncRuns)
        .where(eq(jiraSyncRuns.connectionId, connectionId));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: 'error', error: 'interrupted' });
      // No lease is left behind: the retry starts immediately.
      expect(await runSync(h.deps, job)).toMatchObject({ ok: true, mode: 'full', boards: 2 });
    });

    it('a job whose signal is aborted is retried (interrupted is retryable, not permanent)', async () => {
      const { job } = await setup();
      const abort = new AbortController();
      abort.abort();
      await expect(handleSyncJob(h.deps, job, { signal: abort.signal })).rejects.toMatchObject({
        name: 'RetryableSyncError',
        code: 'interrupted',
      });
      await expect(handleSyncJob({ ...h.deps, signal: abort.signal }, job)).rejects.toBeInstanceOf(
        RetryableSyncError,
      );
      expect(PERMANENT_CODES).not.toContain('interrupted');
      expect(RETRYABLE_CODES.has('interrupted')).toBe(true);
    });

    it('treats a lease as abandoned after 10 minutes', async () => {
      expect(LEASE_MS).toBe(10 * 60_000);
      const { job, connectionId } = await setup();
      await runSync(h.deps, job);
      const leaseAge = (minutes: number) =>
        h.rawDb
          .update(jiraSyncStates)
          .set({
            status: 'running',
            lastStartedAt: sql`now() - ${minutes} * interval '1 minute'`,
          })
          .where(eq(jiraSyncStates.connectionId, connectionId));
      await leaseAge(9);
      expect(await runSync(h.deps, job)).toEqual({ ok: false, code: 'already_running' });
      await leaseAge(11);
      expect(await runSync({ ...h.deps, now: () => min(30) }, job)).toMatchObject({ ok: true });
    });
  });

  describe('I2 DNS failures', () => {
    it('maps an unresolvable host to the retryable unreachable, a private address to blocked_url', async () => {
      const org = 'org_dns';
      const created = await createJiraConnection(
        {
          ...h.deps,
          resolve: async () => ['93.184.216.34'],
          testJira: async () => ({
            ok: true as const,
            deployment: 'datacenter' as const,
            version: '10',
            account: { id: 'x', displayName: 'X' },
          }),
        },
        owner(org),
        {
          name: 'Named host',
          credentials: {
            kind: 'datacenter_pat',
            baseUrl: 'https://jira.corp.example',
            token: 'pat',
          },
        },
      );
      if (!created.ok) throw new Error(`setup: ${created.code}`);
      const connectionId = created.connection.id;
      await h.rawDb.insert(jiraBoards).values({
        orgId: org,
        connectionId,
        jiraBoardId: 1,
        name: 'DEMO',
        type: 'scrum',
        selected: true,
      });
      const job = { orgId: org, connectionId, trigger: 'schedule' as const };
      const dnsDown: SyncDeps = {
        ...h.deps,
        resolve: async () => {
          throw Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' });
        },
      };
      expect(await runSync(dnsDown, job)).toEqual({ ok: false, code: 'unreachable' });
      expect(await stateOf(connectionId)).toMatchObject({ lastError: 'unreachable' });
      await expect(handleSyncJob(dnsDown, job)).rejects.toMatchObject({ code: 'unreachable' });
      const privateIp: SyncDeps = { ...h.deps, resolve: async () => ['10.0.0.8'] };
      expect(await runSync(privateIp, job)).toEqual({ ok: false, code: 'blocked_url' });
    });
  });

  describe('I3 per-board progress', () => {
    it('one board rejected by Jira (400) does not hold back the others', async () => {
      const { job, connectionId } = await setup();
      expect(await runSync(h.deps, job)).toMatchObject({ ok: true, mode: 'full' });
      const rejectDemo = wrap((real) => ({
        searchIssues: (jql, fields) => {
          if (jql.startsWith('filter = 101')) {
            throw Object.assign(new Error('filter gone'), { status: 400 });
          }
          return real.searchIssues(jql, fields);
        },
      }));
      const r = await runSync({ ...h.deps, now: () => min(30), createSource: rejectDemo }, job);
      expect(r).toEqual({ ok: false, code: 'board_query_rejected' });

      const demo = await boardRow(connectionId, 'DEMO Scrum');
      const ops = await boardRow(connectionId, 'OPS Kanban');
      expect(demo).toMatchObject({ lastError: 'board_query_rejected', watermark: NOW });
      expect(ops).toMatchObject({ lastError: null, watermark: min(30), lastFullSyncAt: NOW });
      // The connection shows the first failure, for the UI.
      expect(await stateOf(connectionId)).toMatchObject({
        status: 'error',
        lastError: 'board_query_rejected',
      });

      // Next run: each board reads from its own watermark.
      h.mock.requests.length = 0;
      expect(await runSync({ ...h.deps, now: () => min(60) }, job)).toMatchObject({
        ok: true,
        mode: 'incremental',
      });
      const jqls = h.mock.requests
        .filter((q) => q.path.endsWith('/rest/api/2/search'))
        .map((q) => new URLSearchParams(q.search).get('jql') ?? '');
      expect(jqls.some((j) => /^filter = 102 AND updated >= "-45m"/.test(j))).toBe(true);
      expect(jqls.some((j) => /^filter = 101 AND updated >= "-75m"/.test(j))).toBe(true);
      expect(await boardRow(connectionId, 'DEMO Scrum')).toMatchObject({
        lastError: null,
        watermark: min(60),
      });
      expect(await stateOf(connectionId)).toMatchObject({ status: 'ok', lastError: null });
    });

    it('a board that failed its first read is read completely next time; the others stay incremental', async () => {
      const { job, connectionId } = await setup();
      const rejectOps = wrap((real) => ({
        searchIssues: (jql, fields) => {
          if (jql.startsWith('filter = 102')) {
            throw Object.assign(new Error('bad filter'), { status: 400 });
          }
          return real.searchIssues(jql, fields);
        },
      }));
      expect(await runSync({ ...h.deps, createSource: rejectOps }, job)).toEqual({
        ok: false,
        code: 'board_query_rejected',
      });
      expect(await boardRow(connectionId, 'DEMO Scrum')).toMatchObject({ watermark: NOW });
      expect(await boardRow(connectionId, 'OPS Kanban')).toMatchObject({
        watermark: null,
        lastFullSyncAt: null,
      });
      h.mock.requests.length = 0;
      await runSync({ ...h.deps, now: () => min(30) }, job);
      const jqls = h.mock.requests
        .filter((q) => q.path.endsWith('/rest/api/2/search'))
        .map((q) => new URLSearchParams(q.search).get('jql') ?? '');
      expect(jqls.some((j) => /^filter = 101 AND updated >= "-45m"/.test(j))).toBe(true);
      expect(jqls.some((j) => /^filter = 102 ORDER BY/.test(j))).toBe(true);
    });

    it('records board_not_found on a board whose configuration is gone', async () => {
      const { job, connectionId } = await setup();
      const gone = wrap((real) => ({
        getBoardConfig: async (id) => {
          if (id === 2) throw Object.assign(new Error('Board not found'), { status: 404 });
          return real.getBoardConfig(id);
        },
      }));
      expect(await runSync({ ...h.deps, createSource: gone }, job)).toEqual({
        ok: false,
        code: 'board_not_found',
      });
      expect(await boardRow(connectionId, 'OPS Kanban')).toMatchObject({
        lastError: 'board_not_found',
      });
      expect(await boardRow(connectionId, 'DEMO Scrum')).toMatchObject({
        lastError: null,
        watermark: NOW,
      });
      const ops = (await listBoards(h.deps, job.orgId, connectionId)).find(
        (b) => b.name === 'OPS Kanban',
      );
      expect(ops?.lastError).toBe('board_not_found');
    });

    it('derives connection-wide, permanent and retryable codes from one table', () => {
      for (const c of ['oauth_expired', 'oauth_unavailable', 'blocked_url', 'not_found'] as const) {
        expect(CONNECTION_WIDE_CODES.has(c)).toBe(true);
      }
      expect(CONNECTION_WIDE_CODES.has('board_query_rejected')).toBe(false);
      expect(CONNECTION_WIDE_CODES.has('board_not_found')).toBe(false);
      expect([...PERMANENT_CODES].sort()).toEqual(
        Object.entries(SYNC_FAILURE_CODES)
          .filter(([, b]) => b.permanent)
          .map(([c]) => c)
          .sort(),
      );
      expect([...RETRYABLE_CODES].sort()).toEqual([
        'interrupted',
        'rate_limited',
        'unreachable',
        'workspace_busy',
      ]);
    });
  });

  describe('I4 board discovery', () => {
    it('lists boards without reading any board configuration', async () => {
      const org = `org_x${++n}`;
      const connectionId = await h.connect(owner(org), 'Jira');
      h.mock.requests.length = 0;
      const r = await discoverBoards(h.deps, owner(org), connectionId);
      expect(r.ok && r.boards.map((b) => b.name)).toEqual(['DEMO Scrum', 'OPS Kanban']);
      expect(h.mock.requests.filter((q) => q.path.endsWith('/configuration'))).toEqual([]);
    });

    it('does not fail because one board would fail; selection loads the configuration', async () => {
      const org = `org_x${++n}`;
      const connectionId = await h.connect(owner(org), 'Jira');
      const deps = {
        ...h.deps,
        createSource: wrap((real) => ({
          getBoardConfig: async (id) => {
            if (id === 2) throw Object.assign(new Error('Board not found'), { status: 404 });
            return real.getBoardConfig(id);
          },
        })),
      };
      const found = await discoverBoards(deps, owner(org), connectionId);
      expect(found.ok && found.boards.length).toBe(2);
      const boards = await listBoards(deps, org, connectionId);
      expect(
        await setBoardSelection(
          deps,
          owner(org),
          connectionId,
          boards.map((b) => b.id),
        ),
      ).toEqual({ ok: true, selected: 2 });
      const after = await listBoards(deps, org, connectionId);
      const demo = after.find((b) => b.name === 'DEMO Scrum');
      const ops = after.find((b) => b.name === 'OPS Kanban');
      // Configuration (estimation field, column statuses) was read for the selected boards.
      expect(demo).toMatchObject({ selected: true, usesEstimates: true, lastError: null });
      expect(
        (await listStatusMappings(deps, org, demo?.id ?? '')).map((m) => m.statusName),
      ).toEqual(['Blocked', 'Done', 'In Progress', 'In Review', 'To Do']);
      // The broken board stays selected and shows why.
      expect(ops).toMatchObject({ selected: true, lastError: 'board_not_found' });
      expect(await listStatusMappings(deps, org, ops?.id ?? '')).toEqual([]);
      // A later selection does not re-read boards whose configuration is known.
      h.mock.requests.length = 0;
      await setBoardSelection(h.deps, owner(org), connectionId, [demo?.id ?? '']);
      expect(h.mock.requests.filter((q) => q.path.endsWith('/configuration'))).toEqual([]);
    });
  });

  describe('I6 team-managed boards', () => {
    it('reads the sprints of a team-managed board, and treats "no sprints" (400) as none', async () => {
      const boards = h.dataset.boards;
      const sprints = h.dataset.sprints;
      const demo = boards[0];
      const ops = boards[1];
      if (!demo || !ops) throw new Error('fixture');
      h.dataset.boards = [
        ...boards,
        { ...demo, id: 3, name: 'TEAM Sprints', type: 'simple' },
        { ...ops, id: 4, name: 'TEAM Flow', type: 'simple' },
      ];
      h.dataset.sprints = [
        ...sprints,
        { id: 30, boardId: 3, name: 'TEAM Sprint 1', state: 'active', goal: 'Ship' },
      ];
      try {
        const { job, connectionId } = await setup(['TEAM Sprints', 'TEAM Flow']);
        expect(await runSync(h.deps, job)).toMatchObject({ ok: true, boards: 2 });
        const sprintCount = async (name: string) => {
          const board = await boardRow(connectionId, name);
          const [row] = await h.rawDb
            .select({ n: count() })
            .from(jiraBoardSprints)
            .where(eq(jiraBoardSprints.boardId, board?.id ?? ''));
          return row?.n;
        };
        expect(await sprintCount('TEAM Sprints')).toBe(1);
        expect(await sprintCount('TEAM Flow')).toBe(0);
        expect(await boardRow(connectionId, 'TEAM Flow')).toMatchObject({ lastError: null });
        const [mapped] = await h.rawDb
          .select({ n: count() })
          .from(jiraStatusMappings)
          .where(eq(jiraStatusMappings.orgId, job.orgId));
        expect(mapped?.n).toBeGreaterThan(0);
      } finally {
        h.dataset.boards = boards;
        h.dataset.sprints = sprints;
      }
    });
  });
});
