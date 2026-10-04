import {
  jiraBoards,
  jiraIssueChanges,
  jiraIssues,
  jiraIssueTransitions,
  jiraSprintIssues,
  jiraSyncRuns,
  jiraSyncStates,
} from '@agile/db';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverBoards, listBoards, setBoardSelection } from './boards';
import { runSync } from './run-sync';
import { NOW, owner, startSyncHarness } from './test-harness';

describe('runSync resilience', () => {
  let h: Awaited<ReturnType<typeof startSyncHarness>>;
  let connectionId = '';
  const job = () => ({ orgId: 'org_a', connectionId, trigger: 'manual' as const });
  const state = async () => {
    const [s] = await h.rawDb.select().from(jiraSyncStates);
    return s;
  };

  beforeAll(async () => {
    // An issue whose inline changelog is truncated (130 entries, Jira inlines 100).
    h = await startSyncHarness({ maxPageSize: 100 });
    const issue = h.dataset.issues[0];
    const template = issue?.histories.find((x) => x.items.some((i) => i.field === 'status'));
    if (!issue || !template) throw new Error('dataset changed');
    issue.histories = Array.from({ length: 130 }, (_, n) => ({ ...template, id: String(n + 1) }));
    connectionId = await h.connect();
    await discoverBoards(h.deps, owner(), connectionId);
    const boards = await listBoards(h.deps, 'org_a', connectionId);
    await setBoardSelection(
      h.deps,
      owner(),
      connectionId,
      boards.map((b) => b.id),
    );
  });
  afterAll(async () => h?.stop());

  const snapshot = async () => {
    const [issues] = await h.rawDb.select({ n: count() }).from(jiraIssues);
    const [tr] = await h.rawDb.select({ n: count() }).from(jiraIssueTransitions);
    const [ch] = await h.rawDb.select({ n: count() }).from(jiraIssueChanges);
    const sp = await h.rawDb.select().from(jiraSprintIssues);
    return {
      issues: issues?.n,
      transitions: tr?.n,
      changes: ch?.n,
      sprintRows: sp
        .map((r) => `${r.issueId}/${r.jiraSprintId}/${r.addedAt.toISOString()}/${r.removedAt}`)
        .sort(),
    };
  };

  it('stores every transition of an issue whose changelog was truncated inline', async () => {
    const first = h.dataset.issues[0];
    expect(await runSync(h.deps, job())).toMatchObject({ ok: true, mode: 'full' });
    const [row] = await h.rawDb
      .select()
      .from(jiraIssues)
      .where(eq(jiraIssues.key, first?.key ?? ''));
    const t = await h.rawDb
      .select()
      .from(jiraIssueTransitions)
      .where(eq(jiraIssueTransitions.issueId, row?.id ?? ''));
    expect(t).toHaveLength(130);
  });

  it('a repeated sync replaces history wholesale and keeps sprint membership stable', async () => {
    const before = await snapshot();
    await h.rawDb
      .update(jiraBoards)
      .set({ lastFullSyncAt: new Date(NOW.getTime() - 25 * 3_600_000) });
    // A LATER clock: added_at (part of the primary key) must not depend on when we sync.
    const later = { ...h.deps, now: () => new Date(NOW.getTime() + 2 * 3_600_000) };
    expect(await runSync(later, job())).toMatchObject({ ok: true, mode: 'full' });
    const after = await snapshot();
    expect(after.sprintRows.length).toBeGreaterThan(0);
    expect(after).toEqual(before);
    // An issue whose history shrank in Jira loses the stale rows.
    const first = h.dataset.issues[0];
    if (!first) throw new Error('fixture');
    first.histories = first.histories.slice(0, 40);
    await h.rawDb
      .update(jiraBoards)
      .set({ lastFullSyncAt: new Date(NOW.getTime() - 25 * 3_600_000) });
    await runSync(h.deps, job());
    const [row] = await h.rawDb.select().from(jiraIssues).where(eq(jiraIssues.key, first.key));
    const t = await h.rawDb
      .select()
      .from(jiraIssueTransitions)
      .where(eq(jiraIssueTransitions.issueId, row?.id ?? ''));
    expect(t).toHaveLength(40);
  });

  it('a failed run keeps the watermark and the last full sync, and stores only a code', async () => {
    const good = await state();
    const wm = good?.watermark;
    h.mock.requests.length = 0;
    // Jira starts answering 401 (token revoked): the run fails with a code.
    const failing = {
      ...h.deps,
      now: () => new Date(NOW.getTime() + 3_600_000),
      createSource: () => {
        throw Object.assign(new Error('secret-token-leak'), { status: 401 });
      },
    };
    expect(await runSync(failing, job())).toEqual({ ok: false, code: 'unauthorized' });
    const after = await state();
    expect(after).toMatchObject({ status: 'error', lastError: 'unauthorized' });
    expect(after?.watermark).toEqual(wm);
    expect(after?.lastFullSyncAt).toEqual(good?.lastFullSyncAt);
    const runs = await h.rawDb.select().from(jiraSyncRuns).where(eq(jiraSyncRuns.status, 'error'));
    expect(JSON.stringify(runs)).not.toContain('secret-token-leak');
    // The next run starts from the old watermark (a 1h+ window), and succeeds.
    const later = new Date(NOW.getTime() + 2 * 3_600_000);
    expect(await runSync({ ...h.deps, now: () => later }, job())).toMatchObject({
      ok: true,
      mode: 'incremental',
    });
    expect((await state())?.watermark).toEqual(later);
  });

  it('fails cleanly, with a code and no advanced watermark, on hostile paging', async () => {
    const before = await state();
    const hostile = {
      ...h.deps,
      now: () => new Date(NOW.getTime() + 5 * 3_600_000),
      createSource: (...args: Parameters<NonNullable<typeof h.deps.createSource>>) => {
        throw Object.assign(new Error('paging'), { name: 'JiraPaginationError', args });
      },
    };
    const r = await runSync(hostile, job());
    expect(r.ok).toBe(false);
    const after = await state();
    expect(after?.status).toBe('error');
    expect(after?.watermark).toEqual(before?.watermark);
    expect(after?.lastError).toMatch(/^[a-z_]+$/);
  });
});
