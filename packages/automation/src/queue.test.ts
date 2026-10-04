import { auditLog, skillRuns, withOrg } from '@agile/db';
import { createSkill, serializeSkill, setSkillEnabled, setSkillVisibility } from '@agile/skills';
import { startSyncQueue } from '@agile/sync';
import { member, owner } from '@agile/sync/testing';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  enqueueSkillRuns,
  handleSkillJob,
  requestSkillRun,
  SKILL_RUN_QUEUE,
  SKILL_TICK_CRON,
  SKILL_TICK_QUEUE,
  startSkillWorker,
} from './queue';
import { createRun, SKILL_MANUAL_RUNS_PER_USER } from './runs';
import { startAutomationHarness } from './test-harness';

describe('"Run now" and the skill worker (pg-boss)', () => {
  let h: Awaited<ReturnType<typeof startAutomationHarness>>;
  let boss: PgBoss;
  const outcomes: string[] = [];
  beforeAll(async () => {
    h = await startAutomationHarness();
    boss = await startSyncQueue(h.tdb.appUrl, { role: 'worker' });
    await startSkillWorker(boss, h.deps, {
      onOutcome: (_job, outcome) => outcomes.push(outcome.status),
    });
  });
  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await h?.stop();
  });

  const create = async (
    actor = owner(),
    trigger: 'schedule' | 'on_demand' = 'schedule',
    name = `skill-${Math.random().toString(36).slice(2, 8)}`,
  ) => {
    const r = await createSkill(h.db, actor, {
      document: serializeSkill({
        frontmatter: {
          name,
          description: 'Test',
          trigger,
          ...(trigger === 'schedule'
            ? { schedule: { cron: '0 8 * * 1' }, output: 'email' as const }
            : {}),
        },
        instructions: 'Report.',
      }),
      now: new Date(),
    });
    if (!r.ok) throw new Error(r.code);
    return r.id;
  };
  const deps = () => ({ db: h.db, boss, dailyLimit: 50, now: new Date() });

  async function waitForRun(runId: string) {
    const until = Date.now() + 30_000;
    for (;;) {
      const [run] = await h.rawDb.select().from(skillRuns).where(eq(skillRuns.id, runId));
      if (run && run.status !== 'queued' && run.status !== 'running') return run;
      if (Date.now() > until) throw new Error('run did not finish');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it('queues a manual run that the worker executes and delivers', async () => {
    const id = await create();
    const r = await requestSkillRun(deps(), owner(), id);
    if (!r.ok) throw new Error(r.code);
    expect(r.queued).toBe(true);
    const run = await waitForRun(r.runId);
    expect(run).toMatchObject({
      trigger: 'manual',
      status: 'succeeded',
      deliveries: { email: 'sent' },
    });
    expect(outcomes).toContain('succeeded');
    const audit = await h.rawDb
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.action, 'skill.run_requested'));
    expect(audit).toEqual([{ metadata: { runId: r.runId, queued: true } }]);
  });

  it('only lets the owner run a scheduled or alert skill', async () => {
    const mine = await create(owner());
    const shared = await create(member());
    await setSkillVisibility(h.db, member(), shared, 'workspace');
    const privateOne = await create(member());
    const onDemand = await create(owner(), 'on_demand');
    expect(await requestSkillRun(deps(), member(), mine)).toEqual({ ok: false, code: 'not_found' });
    expect(await requestSkillRun(deps(), owner(), shared)).toEqual({
      ok: false,
      code: 'forbidden',
    });
    expect(await requestSkillRun(deps(), owner(), privateOne)).toEqual({
      ok: false,
      code: 'not_found',
    });
    expect(await requestSkillRun(deps(), owner(), onDemand)).toEqual({
      ok: false,
      code: 'not_runnable',
    });
    expect(await requestSkillRun(deps(), owner('org_b'), mine)).toEqual({
      ok: false,
      code: 'not_found',
    });
    expect(await requestSkillRun(deps(), owner(), 'not-a-uuid')).toEqual({
      ok: false,
      code: 'not_found',
    });
  });

  it('records but does not queue a run over the daily limit', async () => {
    const id = await create();
    const r = await requestSkillRun({ ...deps(), dailyLimit: 0 }, owner(), id);
    expect(r).toMatchObject({ ok: true, queued: false, skipped: 'daily_limit' });
    if (!r.ok) throw new Error('unreachable');
    const [run] = await h.rawDb.select().from(skillRuns).where(eq(skillRuns.id, r.runId));
    expect(run).toMatchObject({ status: 'skipped', resultCode: 'daily_limit' });
  });

  it('does not run a skill that is turned off (M6)', async () => {
    const id = await create(owner(), 'schedule');
    await setSkillEnabled(h.db, owner(), id, false, new Date());
    expect(await requestSkillRun(deps(), owner(), id)).toEqual({ ok: false, code: 'disabled' });
    expect(await h.rawDb.select().from(skillRuns).where(eq(skillRuns.skillId, id))).toEqual([]);
  });

  it('re-sends a run whose job was lost; sent twice, it still runs once (P4-R19)', async () => {
    const name = `lost-${Math.random().toString(36).slice(2, 8)}`;
    const id = await create(owner(), 'schedule', name);
    const now = new Date();
    // Recorded 15 minutes ago, never sent (e.g. the send failed after the commit).
    const run = await withOrg(h.db, 'org_a', (tx) =>
      createRun(tx, 'org_a', {
        skillId: id,
        version: 1,
        trigger: 'manual',
        now: new Date(now.getTime() - 15 * 60_000),
        dailyLimit: 50,
      }),
    );
    if (!run) throw new Error('no run');
    const errors: unknown[] = [];
    const tick = () =>
      enqueueSkillRuns({ db: h.db, boss, dailyLimit: 50, now, onError: (e) => errors.push(e) });
    expect(await tick()).toBeGreaterThanOrEqual(1);
    await tick();
    expect(await waitForRun(run.id)).toMatchObject({ status: 'succeeded' });
    // A third send after it finished is claimed by nobody.
    await tick();
    await new Promise((r) => setTimeout(r, 1_500));
    expect(h.smtp.mails.filter((m) => m.subject.includes(name))).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('never retries a run and lets it outlive its 120 s bound plus delivery before expiry', async () => {
    const queue = await boss.getQueue(SKILL_RUN_QUEUE);
    expect(queue).toMatchObject({ retryLimit: 0, policy: 'exclusive' });
    // 120 s model deadline + 60 s SMTP deadline (or 10 s webhook) + database work, with margin.
    expect(queue?.expireInSeconds).toBeGreaterThanOrEqual(600);
  });

  it('drops a malformed job without running anything', async () => {
    const errors: string[] = [];
    for (const data of [
      null,
      { orgId: 'org_a' },
      { orgId: 'org_a', runId: 'not-a-uuid' },
      { orgId: 'org_a', runId: '00000000-0000-4000-8000-000000000000', extra: 1 },
    ]) {
      expect(
        await handleSkillJob(h.deps, data, {
          onError: (e) => errors.push((e as Error).name),
        }),
      ).toBeUndefined();
    }
    expect(errors).toEqual(Array(4).fill('InvalidSkillJobError'));
  });

  it('schedules the tick every 5 minutes', async () => {
    const schedules = await boss.getSchedules();
    expect(schedules.map((s) => [s.name, s.cron])).toContainEqual([
      SKILL_TICK_QUEUE,
      SKILL_TICK_CRON,
    ]);
  });

  // Last: it uses up the owner's "Run now" allowance for the rest of this file.
  it(`refuses a user's "Run now" beyond ${SKILL_MANUAL_RUNS_PER_USER} a day, with its code (P4-R30)`, async () => {
    const id = await create(owner(), 'schedule');
    // Earlier "Run now" runs of this owner (another skill of theirs), within the last 24 hours.
    const other = await create(owner(), 'schedule');
    const earlier = new Date(Date.now() - 3_600_000);
    for (let i = 0; i < SKILL_MANUAL_RUNS_PER_USER; i++) {
      await withOrg(h.db, 'org_a', (tx) =>
        createRun(tx, 'org_a', {
          skillId: other,
          version: 1,
          trigger: 'manual',
          now: earlier,
          dailyLimit: 1000,
        }),
      );
    }
    const r = await requestSkillRun({ ...deps(), dailyLimit: 1000 }, owner(), id);
    expect(r).toMatchObject({ ok: true, queued: false, skipped: 'user_limit' });
  });
});
