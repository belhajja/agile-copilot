import { jiraSyncStates, organization } from '@agile/db';
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { discoverBoards, getSyncState, listBoards, setBoardSelection } from './boards';
import { enqueueScheduledSyncs, requestSync } from './queue';
import { owner, startSyncHarness } from './test-harness';

const fakeBoss = (send: (...a: unknown[]) => unknown) =>
  ({ send: vi.fn(send) }) as unknown as PgBoss;

describe('queue hardening', () => {
  let h: Awaited<ReturnType<typeof startSyncHarness>>;
  let a = '';
  let b = '';

  beforeAll(async () => {
    h = await startSyncHarness();
    for (const [org, name] of [
      ['org_a', 'A'],
      ['org_b', 'B'],
    ] as const) {
      const id = await h.connect(owner(org), name);
      await discoverBoards(h.deps, owner(org), id);
      const boards = await listBoards(h.deps, org, id);
      await setBoardSelection(
        h.deps,
        owner(org),
        id,
        boards.map((x) => x.id),
      );
      if (org === 'org_a') a = id;
      else b = id;
    }
    await h.rawDb.insert(organization).values([
      { id: 'org_a', name: 'A', slug: 'a', createdAt: new Date() },
      { id: 'org_b', name: 'B', slug: 'b', createdAt: new Date() },
    ]);
  });
  afterAll(async () => {
    await h?.stop();
  });

  it('does not touch the state when send returns null or throws', async () => {
    const before = await getSyncState(h.deps, 'org_a', a);
    expect(await requestSync({ db: h.db, boss: fakeBoss(() => null) }, owner(), a)).toEqual({
      ok: true,
      queued: false,
    });
    await expect(
      requestSync(
        { db: h.db, boss: fakeBoss(() => Promise.reject(new Error('down'))) },
        owner(),
        a,
      ),
    ).rejects.toThrow();
    expect(await getSyncState(h.deps, 'org_a', a)).toEqual(before);
    expect(before.status).not.toBe('queued');
  });

  it('marks queued only after a job id came back', async () => {
    expect(await requestSync({ db: h.db, boss: fakeBoss(() => 'job-1') }, owner(), a)).toEqual({
      ok: true,
      queued: true,
    });
    expect((await getSyncState(h.deps, 'org_a', a)).status).toBe('queued');
  });

  it('tick continues past a failing org and skips connections needing a user action', async () => {
    await requestSync({ db: h.db, boss: fakeBoss(() => 'j') }, owner('org_b'), b); // creates org_b's state row
    await h.rawDb.update(jiraSyncStates).set({ status: 'ok', lastError: null });
    const errors: unknown[] = [];
    const send = vi.fn(async (_q: unknown, data: unknown) => {
      if ((data as { orgId: string }).orgId === 'org_a') throw new Error('boom');
      return 'id';
    });
    const boss = { send } as unknown as PgBoss;
    expect(await enqueueScheduledSyncs({ db: h.db, boss, onError: (e) => errors.push(e) })).toBe(1);
    expect(errors).toHaveLength(1);

    await h.rawDb.update(jiraSyncStates).set({ lastError: 'unauthorized' });
    send.mockClear();
    expect(await enqueueScheduledSyncs({ db: h.db, boss, onError: () => {} })).toBe(0);
    expect(send).not.toHaveBeenCalled();
    // a manual request is still allowed
    expect(await requestSync({ db: h.db, boss: fakeBoss(() => 'j') }, owner('org_b'), b)).toEqual({
      ok: true,
      queued: true,
    });
    await h.rawDb.update(jiraSyncStates).set({ lastError: 'rate_limited' });
    expect(
      await enqueueScheduledSyncs({ db: h.db, boss: fakeBoss(async () => 'i'), onError: () => {} }),
    ).toBe(2);
  });

  it('does not mark queued when the worker already started (and finished) the job', async () => {
    await h.rawDb.update(jiraSyncStates).set({ status: 'idle', lastError: null });
    const fast = fakeBoss(async () => {
      // the worker picks the job up before requestSync gets to flip the state
      await h.rawDb.update(jiraSyncStates).set({ status: 'ok', lastStartedAt: sql`now()` });
      return 'job-fast';
    });
    expect(await requestSync({ db: h.db, boss: fast }, owner(), a)).toEqual({
      ok: true,
      queued: true,
    });
    expect((await getSyncState(h.deps, 'org_a', a)).status).toBe('ok');
  });
});
