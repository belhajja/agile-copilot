import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createJiraConnection } from '@agile/connections';
import { jiraIssues, jiraSyncRuns, jiraSyncStates } from '@agile/db';
import {
  createJiraDataSource,
  type DataSourceOptions,
  type JiraCredentials,
  type JiraCredentialsInput,
} from '@agile/jira';
import { demoDataset, type MockJira, startMockJira } from '@agile/jira/testing';
import { and, eq, sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverBoards, listBoards, setBoardSelection } from './boards';
import type { SyncDeps } from './deps';
import {
  handleSyncJob,
  RetryableSyncError,
  requestSync,
  SYNC_JOB_EXPIRE_SECONDS,
  SYNC_QUEUE,
  SYNC_WORKER_CONCURRENCY,
  startSyncQueue,
  startSyncWorker,
} from './queue';
import { RUN_DEADLINE_MS, runSync, type SyncOutcome } from './run-sync';
import { ANCHOR, NOW, owner, startSyncHarness } from './test-harness';

/** Resolves when `release()` is called: holds a run at a known point. */
const gate = () => {
  let release!: () => void;
  const opened = new Promise<void>((r) => {
    release = r;
  });
  return { opened, release };
};

async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 60_000) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > until) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const servers: Server[] = [];
/**
 * A proxy in front of the mock Jira: everything is forwarded, except issue searches, which get
 * `search` (the F2 tarpit: a body that drips for ever, or a 429 asking for a minute's wait).
 */
async function slowJira(target: string, search: 'drip' | 'retry_after') {
  const server = createServer(async (req, res) => {
    if (req.url?.includes('/rest/api/2/search')) {
      if (search === 'retry_after') {
        res.writeHead(429, { 'retry-after': '60', 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"issues":[');
      const drip = setInterval(() => res.write(' '), 100);
      res.on('close', () => clearInterval(drip));
      return;
    }
    const upstream = await fetch(target + req.url, {
      headers: { authorization: req.headers.authorization ?? '' },
    });
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(await upstream.text());
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Sends every request of a run to `baseUrl` instead of the stored connection's. */
const via =
  (baseUrl: string): SyncDeps['createSource'] =>
  (creds: JiraCredentialsInput, opts: DataSourceOptions) =>
    createJiraDataSource({ ...(creds as JiraCredentials), baseUrl } as JiraCredentials, opts);

describe('sync fairness and bounds (F2 / P5-R48)', () => {
  let h: Awaited<ReturnType<typeof startSyncHarness>>;
  let n = 0;
  const extraMocks: MockJira[] = [];

  beforeAll(async () => {
    h = await startSyncHarness();
  });
  afterAll(async () => {
    for (const s of servers) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
    for (const m of extraMocks) await m.close();
    await h?.stop();
  });

  /** A connection (to its own mock Jira when `own`) with every board selected. */
  const setup = async (org = `org_x${++n}`, own = false) => {
    let url = h.mock.url;
    if (own) {
      const mock = await startMockJira({
        flavor: 'datacenter',
        validAuthorization: 'Bearer good-pat',
        dataset: demoDataset(ANCHOR),
        now: () => NOW,
      });
      extraMocks.push(mock);
      url = mock.url;
    }
    const r = await createJiraConnection(h.deps, owner(org), {
      name: `Jira ${++n}`,
      credentials: { kind: 'datacenter_pat', baseUrl: url, token: 'good-pat' },
    });
    if (!r.ok) throw new Error(`connect failed: ${r.code}`);
    const connectionId = r.connection.id;
    await discoverBoards(h.deps, owner(org), connectionId);
    const boards = await listBoards(h.deps, org, connectionId);
    await setBoardSelection(
      h.deps,
      owner(org),
      connectionId,
      boards.map((b) => b.id),
    );
    return {
      org,
      connectionId,
      url,
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
  const runsOf = (connectionId: string) =>
    h.rawDb
      .select()
      .from(jiraSyncRuns)
      .where(eq(jiraSyncRuns.connectionId, connectionId))
      .orderBy(jiraSyncRuns.startedAt);

  it('runs one sync per workspace at a time; other workspaces are not held back', async () => {
    const a1 = await setup('org_busy', true);
    const a2 = await setup('org_busy', true);
    const b = await setup('org_free', true);
    const hold = gate();
    const reached = gate();
    const paused: SyncDeps['createSource'] = (creds, opts) => {
      const real = createJiraDataSource(creds, opts);
      return {
        ...real,
        listFields: async () => {
          reached.release();
          await hold.opened;
          return real.listFields();
        },
      };
    };
    const first = runSync({ ...h.deps, createSource: paused }, a1.job);
    await reached.opened;
    // The workspace's slot is taken: its other connection waits (retried later by pg-boss)...
    expect(await runSync(h.deps, a2.job)).toEqual({ ok: false, code: 'workspace_busy' });
    expect((await stateOf(a2.connectionId))?.status).not.toBe('running');
    await expect(handleSyncJob(h.deps, a2.job)).rejects.toBeInstanceOf(RetryableSyncError);
    // ...while another workspace syncs at once.
    expect(await runSync(h.deps, b.job)).toMatchObject({ ok: true });
    hold.release();
    expect(await first).toMatchObject({ ok: true });
    expect(await runSync(h.deps, a2.job)).toMatchObject({ ok: true });
  });

  it('a stale lease elsewhere in the workspace does not block it (crashed worker)', async () => {
    const a1 = await setup('org_stale', true);
    const a2 = await setup('org_stale', true);
    await h.rawDb
      .insert(jiraSyncStates)
      .values({
        orgId: 'org_stale',
        connectionId: a1.connectionId,
        status: 'running',
        lastStartedAt: sql`now() - interval '2 hours'`,
      })
      .onConflictDoUpdate({
        target: jiraSyncStates.connectionId,
        set: { status: 'running', lastStartedAt: sql`now() - interval '2 hours'` },
      });
    expect(await runSync(h.deps, a2.job)).toMatchObject({ ok: true });
  });

  it('pg-boss: four slots, at most one active sync per workspace, without burning retries', async () => {
    expect(SYNC_WORKER_CONCURRENCY).toBe(4);
    const busy = [
      await setup('org_q1', true),
      await setup('org_q1', true),
      await setup('org_q1', true),
    ];
    const other = await setup('org_q2', true);
    const orgOf = new Map([...busy, other].map((c) => [c.url, c.org]));
    const active = new Map<string, number>();
    const peak = new Map<string, number>();
    let peakTotal = 0;
    const tracked: SyncDeps['createSource'] = (creds, opts) => {
      const real = createJiraDataSource(creds, opts);
      const org = orgOf.get((creds as JiraCredentials).baseUrl) ?? '?';
      return {
        ...real,
        listFields: async () => {
          active.set(org, (active.get(org) ?? 0) + 1);
          peak.set(org, Math.max(peak.get(org) ?? 0, active.get(org) ?? 0));
          peakTotal = Math.max(
            peakTotal,
            [...active.values()].reduce((x, y) => x + y, 0),
          );
          await new Promise((r) => setTimeout(r, 600));
          active.set(org, (active.get(org) ?? 0) - 1);
          return real.listFields();
        },
      };
    };
    const outcomes: SyncOutcome[] = [];
    const producer = await startSyncQueue(h.tdb.appUrl, { role: 'producer' });
    const worker = await startSyncQueue(h.tdb.appUrl, { role: 'worker' });
    try {
      for (const c of [...busy, other]) {
        expect(
          await requestSync({ db: h.db, boss: producer }, owner(c.org), c.connectionId),
        ).toEqual({ ok: true, queued: true });
      }
      await startSyncWorker(
        worker,
        { ...h.deps, createSource: tracked },
        { intervalMinutes: 60, onOutcome: (_job, o) => outcomes.push(o) },
      );
      const all = [...busy, other].map((c) => c.connectionId);
      const states = await waitFor(
        () => Promise.all(all.map(stateOf)),
        (s) => s.every((x) => x?.status === 'ok' || x?.status === 'error'),
      );
      expect(states.map((s) => s?.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
      expect(peak.get('org_q1')).toBe(1);
      expect(peakTotal).toBeGreaterThanOrEqual(2); // the other workspace ran alongside
      // The extra jobs waited in the queue: none was fetched, refused and retried.
      expect(outcomes.filter((o) => !o.ok)).toEqual([]);
    } finally {
      await worker.stop({ graceful: false });
      await producer.stop({ graceful: false });
    }
  }, 120_000);

  it('expires jobs after 30 minutes, above the run deadline, even on an existing queue', async () => {
    expect(SYNC_JOB_EXPIRE_SECONDS).toBe(1800);
    expect(RUN_DEADLINE_MS).toBeLessThanOrEqual((SYNC_JOB_EXPIRE_SECONDS - 300) * 1000);
    // A queue created by an earlier release (1 h expiry) is brought in line on start.
    const old = new PgBoss({ connectionString: h.tdb.appUrl, createSchema: false });
    await old.start();
    await old.updateQueue(SYNC_QUEUE, { expireInSeconds: 3600 });
    await old.stop({ graceful: false });
    const boss = await startSyncQueue(h.tdb.appUrl, { role: 'producer' });
    try {
      expect((await boss.getQueue(SYNC_QUEUE))?.expireInSeconds).toBe(SYNC_JOB_EXPIRE_SECONDS);
    } finally {
      await boss.stop({ graceful: false });
    }
  });

  it('ends a run that outlives its deadline (a Jira that drips its answer), releasing the lease', async () => {
    const c = await setup();
    const tarpit = await slowJira(c.url, 'drip');
    const started = Date.now();
    const r = await runSync({ ...h.deps, createSource: via(tarpit), runDeadlineMs: 1_500 }, c.job);
    expect(r).toEqual({ ok: false, code: 'timed_out' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await stateOf(c.connectionId)).toMatchObject({
      status: 'error',
      lastError: 'timed_out',
    });
    expect((await runsOf(c.connectionId)).at(-1)).toMatchObject({
      status: 'error',
      error: 'timed_out',
    });
    // Not retried by pg-boss (the next scheduled sync tries again), not a user-only problem.
    await expect(
      handleSyncJob({ ...h.deps, createSource: via(tarpit), runDeadlineMs: 300 }, c.job),
    ).resolves.toEqual({ ok: false, code: 'timed_out' });
  });

  it('a worker stop cuts a Retry-After wait short (no minute-long sleep holds the job)', async () => {
    const c = await setup();
    const limited = await slowJira(c.url, 'retry_after');
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 500);
    const started = Date.now();
    // The real sleep (no injected retry options): only the signal can end the wait.
    const r = await runSync(
      { ...h.deps, retry: undefined, createSource: via(limited), signal: stop.signal },
      c.job,
    );
    expect(r).toEqual({ ok: false, code: 'interrupted' });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect((await stateOf(c.connectionId))?.status).toBe('error');
  });

  it('fences a run whose lease was taken over: it stops writing and leaves the new run alone', async () => {
    const c = await setup();
    const hold = gate();
    const reached = gate();
    let pausedOnce = false;
    const stalls: SyncDeps['createSource'] = (creds, opts) => {
      const real = createJiraDataSource(creds, opts);
      return {
        ...real,
        searchIssues: async function* (jql, fields) {
          if (!pausedOnce) {
            pausedOnce = true;
            reached.release();
            await hold.opened; // a worker that stalls for longer than the lease
          }
          yield* real.searchIssues(jql, fields);
        },
      };
    };
    const stale = runSync({ ...h.deps, createSource: stalls }, c.job);
    await reached.opened;
    await h.rawDb
      .update(jiraSyncStates)
      .set({ lastStartedAt: sql`now() - interval '2 hours'` })
      .where(eq(jiraSyncStates.connectionId, c.connectionId));
    const fresh = await runSync({ ...h.deps, now: () => new Date(NOW.getTime() + 60_000) }, c.job);
    expect(fresh).toMatchObject({ ok: true });
    const after = await stateOf(c.connectionId);
    // Jira changes meanwhile: anything the stalled run still saved would carry this summary.
    const summaries = h.dataset.issues.map((i) => i.fields.summary);
    for (const i of h.dataset.issues) i.fields.summary = 'written by a fenced-off run';
    try {
      hold.release();
      // The stalled run finds its lease gone at its next write and stops there.
      expect(await stale).toEqual({ ok: false, code: 'already_running' });
    } finally {
      h.dataset.issues.forEach((i, k) => {
        i.fields.summary = summaries[k];
      });
    }
    const [leaked] = await h.rawDb
      .select({ n: sql<number>`count(*)::int` })
      .from(jiraIssues)
      .where(
        and(
          eq(jiraIssues.connectionId, c.connectionId),
          eq(jiraIssues.summary, 'written by a fenced-off run'),
        ),
      );
    expect(leaked?.n).toBe(0);
    expect(await stateOf(c.connectionId)).toEqual(after);
    const [oldRun, newRun] = await runsOf(c.connectionId);
    expect(oldRun).toMatchObject({ status: 'error', error: 'abandoned' });
    expect(newRun).toMatchObject({ status: 'ok' });
  });
});
