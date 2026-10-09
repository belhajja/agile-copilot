import { jiraSyncStates, organization } from '@agile/db';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverBoards, getSyncState, listBoards, setBoardSelection } from './boards';
import {
  cronEvery,
  enqueueScheduledSyncs,
  requestSync,
  SYNC_QUEUE,
  SYNC_TICK_QUEUE,
  startSyncQueue,
  startSyncWorker,
} from './queue';
import { manager, owner, startSyncHarness, viewer } from './test-harness';

async function waitFor<T>(
  read: () => Promise<T>,
  done: (v: T) => boolean,
  ms = 30_000,
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > until) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('sync queue (pg-boss, as app_user)', () => {
  let h: Awaited<ReturnType<typeof startSyncHarness>>;
  let producer: PgBoss;
  let connectionId = '';

  beforeAll(async () => {
    h = await startSyncHarness();
    producer = await startSyncQueue(h.tdb.appUrl, { role: 'producer' });
    connectionId = await h.connect();
    await discoverBoards(h.deps, owner(), connectionId);
  });
  afterAll(async () => {
    await producer?.stop({ graceful: false });
    await h?.stop();
  });

  it('needs selected boards before queueing', async () => {
    expect(await requestSync({ db: h.db, boss: producer }, owner(), connectionId)).toEqual({
      ok: false,
      code: 'no_boards',
    });
    for (const actor of [viewer(), manager()]) {
      await expect(
        requestSync({ db: h.db, boss: producer }, actor, connectionId),
      ).rejects.toThrow();
    }
    expect(await requestSync({ db: h.db, boss: producer }, owner('org_b'), connectionId)).toEqual({
      ok: false,
      code: 'not_found',
    });
  });

  it('queues one sync per connection, then a worker runs it', async () => {
    const boards = await listBoards(h.deps, 'org_a', connectionId);
    await setBoardSelection(
      h.deps,
      owner(),
      connectionId,
      boards.map((b) => b.id),
    );
    expect(await requestSync({ db: h.db, boss: producer }, owner(), connectionId)).toEqual({
      ok: true,
      queued: true,
    });
    expect(await requestSync({ db: h.db, boss: producer }, owner(), connectionId)).toEqual({
      ok: true,
      queued: false,
    });
    expect((await getSyncState(h.deps, 'org_a', connectionId)).status).toBe('queued');

    const worker = await startSyncQueue(h.tdb.appUrl, { role: 'worker' });
    try {
      await startSyncWorker(worker, h.deps, { intervalMinutes: 15 });
      const state = await waitFor(
        () => getSyncState(h.deps, 'org_a', connectionId),
        (s) => s.status === 'ok' || s.status === 'error',
      );
      expect(state).toMatchObject({ status: 'ok', lastError: null });
      // The state is written before the handler returns: wait for pg-boss to finish the job, or
      // the next test still finds it active (one sync per connection).
      const jobs = await waitFor(
        () => worker.findJobs(SYNC_QUEUE, { key: connectionId }),
        (list) => list.every((j) => ['completed', 'failed', 'cancelled'].includes(j.state)),
      );
      expect(jobs.map((j) => j.state)).toEqual(['completed']);
      const schedules = await worker.getSchedules();
      expect(schedules.map((s) => [s.name, s.cron, s.timezone])).toEqual([
        [SYNC_TICK_QUEUE, '*/15 * * * *', 'UTC'],
      ]);
    } finally {
      await worker.stop({ graceful: false });
    }
  });

  it('the scheduled tick queues every connection with selected boards', async () => {
    const other = await h.connect(owner('org_b'), 'B');
    await discoverBoards(h.deps, owner('org_b'), other); // nothing selected in org_b
    await h.rawDb.update(jiraSyncStates).set({ status: 'ok' });
    // org_a has one connection with selected boards; org_b has none. Organisations come from better-auth.
    await h.rawDb.insert(organization).values([
      { id: 'org_a', name: 'A', slug: 'a', createdAt: new Date() },
      { id: 'org_b', name: 'B', slug: 'b', createdAt: new Date() },
    ]);
    expect(await enqueueScheduledSyncs({ db: h.db, boss: producer })).toBe(1);
    expect(await enqueueScheduledSyncs({ db: h.db, boss: producer })).toBe(0); // already queued
    await producer.deleteQueuedJobs(SYNC_QUEUE);
  });

  it('builds cron expressions for supported intervals', () => {
    expect(cronEvery(5)).toBe('*/5 * * * *');
    expect(cronEvery(60)).toBe('0 * * * *');
  });
});
