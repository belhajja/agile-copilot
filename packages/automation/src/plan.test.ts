import { randomUUID } from 'node:crypto';
import {
  auditLog,
  deliveryChannels,
  member as memberTable,
  skillRuns,
  skills,
  withOrg,
} from '@agile/db';
import { createSkill, deleteSkill, serializeSkill, setSkillVisibility } from '@agile/skills';
import { member, owner } from '@agile/sync/testing';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALERT_COOLDOWN_HOURS, planSkillRuns } from './plan';
import {
  claimRun,
  closeStaleRuns,
  createRun,
  finishRun,
  listRuns,
  ownerRunShare,
  SKILL_MANUAL_RUNS_PER_USER,
} from './runs';
import { startAutomationHarness } from './test-harness';

const MONDAY_7 = new Date('2026-10-05T07:00:00Z');
const at = (iso: string) => new Date(iso);

describe('planning background runs (schedules, alerts, limits)', () => {
  let h: Awaited<ReturnType<typeof startAutomationHarness>>;
  beforeAll(async () => {
    h = await startAutomationHarness();
  });
  afterAll(async () => h?.stop());
  // Each test starts with no skill planned (its own skills only) and fails on any planning error.
  const errors: unknown[] = [];
  beforeEach(async () => {
    errors.length = 0;
    await h.rawDb.update(skills).set({ enabled: false });
  });
  afterEach(() => expect(errors).toEqual([]));

  const createIn = async (orgId: string, frontmatter: Record<string, unknown>, now = MONDAY_7) => {
    const r = await createSkill(h.db, owner(orgId), {
      document: serializeSkill({
        frontmatter: { description: 'Test', ...frontmatter } as never,
        instructions: 'Report.',
      }),
      channelId: frontmatter.output === 'slack' ? h.slackChannelId : null,
      now,
    });
    if (!r.ok) throw new Error(r.code);
    return r.id;
  };
  const create = (frontmatter: Record<string, unknown>, now = MONDAY_7) =>
    createIn('org_a', frontmatter, now);
  const runsOf = (skillId: string) =>
    h.rawDb.select().from(skillRuns).where(eq(skillRuns.skillId, skillId));
  const planIn = (orgId: string, now: Date, dailyLimit = 50) =>
    planSkillRuns({ db: h.db, dailyLimit, onError: (e) => errors.push(e) }, orgId, now);
  const plan = (now: Date, dailyLimit = 50) => planIn('org_a', now, dailyLimit);
  const manualRunIn = (orgId: string, skillId: string, now: Date, dailyLimit = 50) =>
    withOrg(h.db, orgId, (tx) =>
      createRun(tx, orgId, { skillId, version: 1, trigger: 'manual', now, dailyLimit }),
    );
  const manualRun = (skillId: string, now: Date, dailyLimit = 50) =>
    manualRunIn('org_a', skillId, now, dailyLimit);
  /** Waits until `n` sessions of the app role wait on a lock; returns how many were seen. */
  const lockWaiters = async (n: number) => {
    let seen = 0;
    await vi
      .waitFor(
        async () => {
          const [row] = await h.db.execute<{ n: number }>(
            sql`select count(*)::int as n from pg_stat_activity
                where wait_event_type = 'Lock' and datname = current_database()`,
          );
          seen = row?.n ?? 0;
          expect(seen).toBeGreaterThanOrEqual(n);
        },
        { timeout: 30_000, interval: 25 },
      )
      .catch(() => {});
    return seen;
  };
  /** Holds a lock (taken by `take`) in another session until `release()` is called. */
  const holdLock = async (
    take: (tx: Parameters<Parameters<typeof h.rawDb.transaction>[0]>[0]) => Promise<unknown>,
  ) => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let held = () => {};
    const holding = new Promise<void>((r) => {
      held = r;
    });
    const done = h.rawDb.transaction(async (tx) => {
      await take(tx);
      held();
      await gate;
    });
    await holding;
    return { release, done };
  };
  const disable = (id: string) =>
    h.rawDb.update(skills).set({ enabled: false }).where(eq(skills.id, id));

  it('runs a schedule once per scheduled time, from the save time on', async () => {
    const id = await create({
      name: 'monday-digest',
      trigger: 'schedule',
      schedule: { cron: '0 8 * * 1' },
      output: 'email',
    });
    expect(await plan(at('2026-10-05T07:55:00Z'))).toEqual([]);
    const queued = await plan(at('2026-10-05T08:03:00Z'));
    expect(queued).toHaveLength(1);
    expect(await plan(at('2026-10-05T08:08:00Z'))).toEqual([]);
    expect((await runsOf(id)).map((r) => [r.trigger, r.status, r.scheduledFor])).toEqual([
      ['schedule', 'queued', at('2026-10-05T08:00:00Z')],
    ]);
    await disable(id);
    expect(await plan(at('2026-10-12T08:01:00Z'))).toEqual([]);
  });

  it('fires an alert when a board starts matching, not while it keeps matching', async () => {
    const id = await create({
      name: 'wip-alert',
      trigger: 'alert',
      alert: { metric: 'wip', op: '>=', value: 1 },
      output: 'slack',
    });
    const quiet = await create({
      name: 'never-alert',
      trigger: 'alert',
      alert: { metric: 'wip', op: '>', value: 1000 },
      output: 'chat',
    });
    const first = await plan(at('2026-10-05T09:00:00Z'));
    expect(first).toHaveLength(1);
    const [run] = await runsOf(id);
    const context = run?.context as {
      condition: unknown;
      matches: { board: string; value: number }[];
    };
    expect(context.condition).toEqual({ metric: 'wip', op: '>=', value: 1 });
    expect(context.matches.map((m) => m.board)).toContain('OPS Kanban');
    expect(context.matches.every((m) => m.value >= 1)).toBe(true);
    // Still matching: no new run.
    expect(await plan(at('2026-10-05T09:05:00Z'))).toEqual([]);
    expect(await runsOf(quiet)).toEqual([]);
    // It stops matching, then matches again within the cooldown: still quiet.
    await h.rawDb.update(skills).set({ alertBoards: [] }).where(eq(skills.id, id));
    expect(await plan(at('2026-10-05T10:00:00Z'))).toEqual([]);
    // After the cooldown it fires again.
    await h.rawDb.update(skills).set({ alertBoards: [] }).where(eq(skills.id, id));
    const later = new Date(at('2026-10-05T09:00:00Z').getTime() + ALERT_COOLDOWN_HOURS * 3_600_000);
    expect(await plan(later)).toHaveLength(1);
    await disable(id);
  });

  it("limits a workspace's runs per day; skipped runs say why", async () => {
    const id = await create({
      name: 'hourly',
      trigger: 'schedule',
      schedule: { cron: '0 * * * *' },
      output: 'chat',
    });
    // Two runs earlier today (of another skill): a limit of 2 is reached.
    const seed = await create({
      name: 'hourly-seed',
      trigger: 'schedule',
      schedule: { cron: '0 6 * * *' },
      output: 'chat',
    });
    await disable(seed);
    await manualRun(seed, at('2026-10-05T10:55:00Z'));
    await manualRun(seed, at('2026-10-05T10:56:00Z'));
    expect(await plan(at('2026-10-05T11:01:00Z'), 2)).toEqual([]);
    expect((await runsOf(id)).map((r) => [r.status, r.resultCode])).toEqual([
      ['skipped', 'daily_limit'],
    ]);
    expect(await plan(at('2026-10-05T12:01:00Z'), 50)).toHaveLength(1);
    await disable(id);
  });

  it('closes runs a crashed worker left behind', async () => {
    const id = await create({
      name: 'crashy',
      trigger: 'schedule',
      schedule: { cron: '0 6 * * *' },
      output: 'chat',
    });
    const run = await withOrg(h.db, 'org_a', (tx) =>
      createRun(tx, 'org_a', {
        skillId: id,
        version: 1,
        trigger: 'manual',
        now: MONDAY_7,
        dailyLimit: 50,
      }),
    );
    await h.rawDb
      .update(skillRuns)
      .set({ status: 'running', createdAt: at('2026-10-05T05:00:00Z') })
      .where(eq(skillRuns.id, run?.id ?? ''));
    expect(await closeStaleRuns(h.db, 'org_a', at('2026-10-05T06:00:00Z'))).toBe(1);
    expect((await runsOf(id)).map((r) => [r.status, r.resultCode])).toEqual([
      ['failed', 'interrupted'],
    ]);
  });

  // ---- Controller rulings (P4-R1, R2, R5, R10 L21, R19, daily cap) ----

  it('fires an alert once when two ticks plan it at the same time (P4-R2)', async () => {
    const now = at('2026-10-22T12:00:00Z');
    const id = await create(
      {
        name: 'race-alert',
        trigger: 'alert',
        alert: { metric: 'wip', op: '>=', value: 1 },
        output: 'chat',
      },
      now,
    );
    // Hold the skill row until both ticks are blocked in their transactions, so they truly
    // overlap: each has evaluated the boards and seen no board alerted yet.
    const lock = await holdLock((tx) =>
      tx.select({ id: skills.id }).from(skills).where(eq(skills.id, id)).for('update'),
    );
    const both = Promise.all([plan(now), plan(now)]);
    const waiters = await lockWaiters(2);
    lock.release();
    await lock.done;
    const [a, b] = await both;
    expect(waiters).toBeGreaterThanOrEqual(2);
    expect([...a, ...b]).toHaveLength(1);
    expect(await runsOf(id)).toHaveLength(1);
  });

  it('keeps a board that starts matching during the cooldown able to fire later (P4-R10 L21)', async () => {
    const t0 = at('2026-10-24T08:00:00Z');
    const id = await create(
      {
        name: 'cooldown-alert',
        trigger: 'alert',
        alert: { metric: 'wip', op: '>=', value: 1 },
        output: 'chat',
      },
      t0,
    );
    // Fired an hour ago on no board in particular: the cooldown is running, nothing matched yet.
    await h.rawDb
      .update(skills)
      .set({ alertBoards: [], alertFiredAt: at('2026-10-24T07:00:00Z') })
      .where(eq(skills.id, id));
    expect(await plan(t0)).toEqual([]);
    // Boards matching during the cooldown are not recorded as already alerted...
    const [row] = await h.rawDb.select().from(skills).where(eq(skills.id, id));
    expect(row?.alertBoards).toEqual([]);
    // ...so once the cooldown is over they fire, although they kept matching.
    expect(await plan(at('2026-10-24T19:00:00Z'))).toHaveLength(1);
    const [after] = await h.rawDb.select().from(skills).where(eq(skills.id, id));
    expect(after?.alertBoards.length).toBeGreaterThan(0);
  });

  it('holds the daily limit when two runs are requested at the same time', async () => {
    // A workspace of its own: no other run counts against its day.
    const org = 'org_cap';
    const now = at('2026-10-20T12:00:00Z');
    const id = await createIn(
      org,
      { name: 'cap-race', trigger: 'schedule', schedule: { cron: '0 6 * * *' } },
      now,
    );
    // Hold the workspace's run lock until both requests wait on it, so they truly contend.
    const lock = await holdLock((tx) =>
      tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`skill_runs:${org}`}))`),
    );
    const both = Promise.all([manualRunIn(org, id, now, 1), manualRunIn(org, id, now, 1)]);
    const waiters = await lockWaiters(2);
    lock.release();
    await lock.done;
    const results = await both;
    expect(waiters).toBeGreaterThanOrEqual(2);
    expect(results.map((r) => r?.queued).sort()).toEqual([false, true]);
    expect(
      (await runsOf(id))
        .map((r) => [r.status, r.resultCode])
        .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    ).toEqual([
      ['queued', null],
      ['skipped', 'daily_limit'],
    ]);
  });

  // ---- Daily-cap fairness (P4-R30) ----

  /** A run of `skillId` recorded at `now` (any trigger), in its own workspace. */
  const runIn = (
    orgId: string,
    skillId: string,
    now: Date,
    opts: { trigger?: 'manual' | 'schedule' | 'alert'; dailyLimit?: number } = {},
  ) =>
    withOrg(h.db, orgId, (tx) =>
      createRun(tx, orgId, {
        skillId,
        version: 1,
        trigger: opts.trigger ?? 'manual',
        scheduledFor: opts.trigger === 'schedule' ? now : null,
        now,
        dailyLimit: opts.dailyLimit ?? 1000,
      }),
    );
  const outcomes = (id: string) =>
    runsOf(id).then((rows) =>
      rows
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((r) => (r.status === 'skipped' ? r.resultCode : r.status)),
    );
  const minutes = (base: Date, n: number) => new Date(base.getTime() + n * 60_000);

  it(`lets a user "Run now" at most ${SKILL_MANUAL_RUNS_PER_USER} times per 24 hours (user_limit)`, async () => {
    const org = 'org_user_cap';
    const t0 = at('2026-11-02T08:00:00Z');
    const id = await createIn(
      org,
      { name: 'manual-cap', trigger: 'schedule', schedule: { cron: '0 6 * * *' } },
      t0,
    );
    for (let i = 0; i < SKILL_MANUAL_RUNS_PER_USER; i++) {
      expect((await runIn(org, id, minutes(t0, i)))?.queued).toBe(true);
    }
    expect(await runIn(org, id, minutes(t0, 20))).toMatchObject({
      queued: false,
      skipped: 'user_limit',
    });
    // Schedules and alerts are not "Run now": they still run (within the owner's share).
    expect((await runIn(org, id, minutes(t0, 21), { trigger: 'schedule' }))?.queued).toBe(true);
    // Another member's "Run now" is theirs to spend.
    const theirs = await createSkill(h.db, member(org), {
      document: serializeSkill({
        frontmatter: {
          name: 'theirs',
          description: 'Test',
          trigger: 'schedule',
          schedule: { cron: '0 6 * * *' },
        } as never,
        instructions: 'Report.',
      }),
      now: t0,
    });
    if (!theirs.ok) throw new Error(theirs.code);
    expect((await runIn(org, theirs.id, minutes(t0, 22)))?.queued).toBe(true);
    // A rolling window: 24 hours after the first, a slot is free again.
    expect((await runIn(org, id, minutes(t0, 24 * 60 + 1)))?.queued).toBe(true);
    expect((await outcomes(id)).filter((o) => o === 'user_limit')).toHaveLength(1);
  });

  it("keeps one owner's runs within their share of the workspace's day (owner_limit)", async () => {
    const org = 'org_owner_share';
    const t0 = at('2026-11-03T08:00:00Z');
    // A limit of 10: one owner may use max(5, ceil(10 / 2)) = 5 of it.
    const limit = 10;
    const mine = await createIn(
      org,
      { name: 'hog', trigger: 'schedule', schedule: { cron: '0 * * * *' } },
      t0,
    );
    for (let i = 0; i < 5; i++) {
      const trigger = i % 2 === 0 ? 'schedule' : 'manual';
      expect((await runIn(org, mine, minutes(t0, i), { trigger, dailyLimit: limit }))?.queued).toBe(
        true,
      );
    }
    expect(
      await runIn(org, mine, minutes(t0, 10), { trigger: 'schedule', dailyLimit: limit }),
    ).toMatchObject({ queued: false, skipped: 'owner_limit' });
    expect(
      await runIn(org, mine, minutes(t0, 11), { trigger: 'alert', dailyLimit: limit }),
    ).toMatchObject({ queued: false, skipped: 'owner_limit' });
    // The rest of the workspace's day is still there for everyone else.
    const theirs = await createSkill(h.db, member(org), {
      document: serializeSkill({
        frontmatter: {
          name: 'fair',
          description: 'Test',
          trigger: 'schedule',
          schedule: { cron: '0 6 * * *' },
        } as never,
        instructions: 'Report.',
      }),
      now: t0,
    });
    if (!theirs.ok) throw new Error(theirs.code);
    expect(
      (await runIn(org, theirs.id, minutes(t0, 12), { trigger: 'schedule', dailyLimit: limit }))
        ?.queued,
    ).toBe(true);
    // Small limits: the share never drops below 5 runs, the workspace limit still binds.
    expect(ownerRunShare(10)).toBe(5);
    expect(ownerRunShare(3)).toBe(5);
    expect(ownerRunShare(50)).toBe(25);
    expect(ownerRunShare(51)).toBe(26);
    // 0 still turns every run off.
    expect(
      await runIn(org, theirs.id, minutes(t0, 13), { trigger: 'schedule', dailyLimit: 0 }),
    ).toMatchObject({ queued: false, skipped: 'daily_limit' });
  });

  it('counts only runs that may reach the model against the caps', async () => {
    const org = 'org_pre_model';
    const t0 = at('2026-11-04T08:00:00Z');
    const id = await createIn(
      org,
      { name: 'pre-model', trigger: 'schedule', schedule: { cron: '0 6 * * *' } },
      t0,
    );
    // Ended before any model call: refused role, invalid document, no model, owner gone, skips.
    const ended = [
      ['failed', 'forbidden_role'],
      ['failed', 'invalid_skill'],
      ['failed', 'no_llm'],
      ['skipped', 'owner_left'],
      ['skipped', 'disabled'],
    ] as const;
    for (const [i, [status, resultCode]] of ended.entries()) {
      const run = await runIn(org, id, minutes(t0, i), { dailyLimit: 1 });
      expect(run?.queued).toBe(true);
      await h.rawDb
        .update(skillRuns)
        .set({ status, resultCode })
        .where(eq(skillRuns.id, run?.id ?? ''));
    }
    // None of them used the workspace's single run, nor the user's "Run now" allowance.
    const counted = await runIn(org, id, minutes(t0, 10), { dailyLimit: 1 });
    expect(counted?.queued).toBe(true);
    // A run that reached the model counts, whatever its outcome.
    await h.rawDb
      .update(skillRuns)
      .set({ status: 'failed', resultCode: 'model_failed' })
      .where(eq(skillRuns.id, counted?.id ?? ''));
    expect(await runIn(org, id, minutes(t0, 11), { dailyLimit: 1 })).toMatchObject({
      queued: false,
      skipped: 'daily_limit',
    });
  });

  it('keeps the caps when a skill is deleted and created again (P4-R31)', async () => {
    const org = 'org_delete_cap';
    const t0 = at('2026-11-07T08:00:00Z');
    const doc = { name: 'reborn', trigger: 'schedule', schedule: { cron: '0 6 * * *' } };
    const first = await createIn(org, doc, t0);
    for (let i = 0; i < SKILL_MANUAL_RUNS_PER_USER; i++) {
      expect((await runIn(org, first, minutes(t0, i)))?.queued).toBe(true);
    }
    expect((await deleteSkill(h.db, owner(org), first)).ok).toBe(true);
    // The history stays (no skill any more), still counted for its owner.
    const kept = await h.rawDb.select().from(skillRuns).where(eq(skillRuns.orgId, org));
    expect(kept.map((r) => [r.skillId, r.ownerUserId])).toEqual(
      Array(SKILL_MANUAL_RUNS_PER_USER).fill([null, owner(org).userId]),
    );
    const again = await createIn(org, doc, t0);
    expect(await runIn(org, again, minutes(t0, 30))).toMatchObject({
      queued: false,
      skipped: 'user_limit',
    });
    // The owner's share too: 10 runs used of max(5, ceil(10 / 2)) = 5.
    expect(
      await runIn(org, again, minutes(t0, 31), { trigger: 'schedule', dailyLimit: 10 }),
    ).toMatchObject({ queued: false, skipped: 'daily_limit' });
    expect(
      await runIn(org, again, minutes(t0, 32), { trigger: 'schedule', dailyLimit: 20 }),
    ).toMatchObject({ queued: false, skipped: 'owner_limit' });
  });

  it('records an alert skipped by a limit once per limit and day, not on every tick', async () => {
    // Before the other org_a alert test's days: the daily window has no upper bound.
    const t0 = at('2026-11-01T08:00:00Z');
    const id = await create(
      {
        name: 'capped-alert-once',
        trigger: 'alert',
        alert: { metric: 'wip', op: '>=', value: 1 },
        output: 'chat',
      },
      t0,
    );
    const seed = await create(
      { name: 'cap-seed-once', trigger: 'schedule', schedule: { cron: '0 6 * * *' } },
      t0,
    );
    await disable(seed);
    const used = await runIn('org_a', seed, minutes(t0, -30), { dailyLimit: 1 });
    await h.rawDb
      .update(skillRuns)
      .set({ status: 'succeeded' })
      .where(eq(skillRuns.id, used?.id ?? ''));
    for (let tick = 0; tick < 4; tick++) {
      expect(await planIn('org_a', minutes(t0, tick * 5), 1)).toEqual([]);
    }
    expect(await outcomes(id)).toEqual(['daily_limit']);
    await disable(id);
  });

  it('holds the "Run now" limit when two runs are requested at the same time', async () => {
    const org = 'org_user_race';
    const now = at('2026-11-05T12:00:00Z');
    const id = await createIn(
      org,
      { name: 'user-race', trigger: 'schedule', schedule: { cron: '0 6 * * *' } },
      now,
    );
    for (let i = 0; i < SKILL_MANUAL_RUNS_PER_USER - 1; i++) {
      await runIn(org, id, minutes(now, -60 + i));
    }
    const lock = await holdLock((tx) =>
      tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`skill_runs:${org}`}))`),
    );
    const both = Promise.all([runIn(org, id, now), runIn(org, id, now)]);
    const waiters = await lockWaiters(2);
    lock.release();
    await lock.done;
    const results = await both;
    expect(waiters).toBeGreaterThanOrEqual(2);
    expect(results.map((r) => r?.skipped ?? null).sort()).toEqual([null, 'user_limit'].sort());
  });

  it('does not use up an alert that the daily limit skipped: it fires on a later tick', async () => {
    // The synced demo boards are in org_a; no other run of org_a falls on this day.
    const org = 'org_a';
    const t0 = at('2026-11-06T08:00:00Z');
    const id = await createIn(
      org,
      {
        name: 'capped-alert',
        trigger: 'alert',
        alert: { metric: 'wip', op: '>=', value: 1 },
        output: 'chat',
      },
      t0,
    );
    // Another skill used the workspace's only run of the day.
    const seed = await createIn(
      org,
      { name: 'cap-seed', trigger: 'schedule', schedule: { cron: '0 6 * * *' } },
      t0,
    );
    await h.rawDb.update(skills).set({ enabled: false }).where(eq(skills.id, seed));
    const used = await runIn(org, seed, minutes(t0, -30), { dailyLimit: 1 });
    await h.rawDb
      .update(skillRuns)
      .set({ status: 'succeeded' })
      .where(eq(skillRuns.id, used?.id ?? ''));
    expect(await planIn(org, t0, 1)).toEqual([]);
    const [skipped] = await h.rawDb.select().from(skills).where(eq(skills.id, id));
    expect([skipped?.alertBoards, skipped?.alertFiredAt]).toEqual([[], null]);
    expect(await outcomes(id)).toEqual(['daily_limit']);
    // The day rolls over: the boards still match, so the alert fires now.
    expect(await planIn(org, minutes(t0, 24 * 60), 1)).toHaveLength(1);
    const [fired] = await h.rawDb.select().from(skills).where(eq(skills.id, id));
    expect(fired?.alertBoards.length).toBeGreaterThan(0);
    expect(fired?.alertFiredAt).toEqual(minutes(t0, 24 * 60));
  });

  it('snapshots the output and an in-workspace channel into the run (P4-R5)', async () => {
    const now = at('2026-10-25T12:00:00Z');
    const id = await create(
      { name: 'snap', trigger: 'schedule', schedule: { cron: '0 6 * * *' }, output: 'slack' },
      now,
    );
    await disable(id);
    const first = await manualRun(id, now);
    // A channel of another workspace: foreign keys bypass RLS, so the snapshot filters by org.
    const foreign = randomUUID();
    await h.rawDb.insert(deliveryChannels).values({
      id: foreign,
      orgId: 'org_b',
      kind: 'slack',
      name: 'Elsewhere',
      hint: 'hooks.example.com',
      secret: 'x',
      createdBy: 'user_org_b',
    });
    await h.rawDb.update(skills).set({ channelId: foreign }).where(eq(skills.id, id));
    const second = await manualRun(id, now);
    const rows = await runsOf(id);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect([byId.get(first?.id ?? '')?.outputKind, byId.get(first?.id ?? '')?.channelId]).toEqual([
      'slack',
      h.slackChannelId,
    ]);
    expect([byId.get(second?.id ?? '')?.outputKind, byId.get(second?.id ?? '')?.channelId]).toEqual(
      ['slack', null],
    );
    // An unknown skill id records nothing.
    expect(await manualRun(randomUUID(), now)).toBeNull();
    expect(await manualRun('not-a-uuid', now)).toBeNull();
  });

  it('shows run outputs and deliveries to the skill owner only (P4-R1)', async () => {
    const now = at('2026-10-26T12:00:00Z');
    const id = await create(
      { name: 'shared-report', trigger: 'schedule', schedule: { cron: '0 6 * * *' } },
      now,
    );
    await disable(id);
    expect((await setSkillVisibility(h.db, owner(), id, 'workspace')).ok).toBe(true);
    const run = await manualRun(id, now);
    expect(await claimRun(h.db, 'org_a', run?.id ?? '', now)).toBe(true);
    expect(
      await finishRun(h.db, 'org_a', run?.id ?? '', now, {
        status: 'succeeded',
        output: 'Live Jira report',
        deliveries: { email: 'sent' },
      }),
    ).toBe(true);
    const [mine] = await listRuns(h.db, owner(), id);
    expect([mine?.status, mine?.output, mine?.deliveries]).toEqual([
      'succeeded',
      'Live Jira report',
      { email: 'sent' },
    ]);
    const [theirs] = await listRuns(h.db, member(), id);
    expect([theirs?.status, theirs?.resultCode, theirs?.output, theirs?.deliveries]).toEqual([
      'succeeded',
      null,
      null,
      {},
    ]);
    // A private skill of someone else: no runs at all.
    expect((await setSkillVisibility(h.db, owner(), id, 'private')).ok).toBe(true);
    expect(await listRuns(h.db, member(), id)).toEqual([]);
    expect(await listRuns(h.db, owner(), 'not-a-uuid')).toEqual([]);
  });

  it('re-sends runs left queued for 10 minutes; claiming keeps the re-send harmless (P4-R19)', async () => {
    const org = 'org_resend';
    const now = at('2026-10-21T12:00:00Z');
    const id = await createIn(
      org,
      { name: 'lost', trigger: 'schedule', schedule: { cron: '0 6 * * *' } },
      now,
    );
    const old = await manualRunIn(org, id, at('2026-10-21T11:45:00Z'));
    const fresh = await manualRunIn(org, id, at('2026-10-21T11:55:00Z'));
    expect(await planIn(org, now)).toEqual([old?.id]);
    // Every tick re-sends it while it waits; the worker's claim runs it once.
    expect(await planIn(org, now)).toEqual([old?.id]);
    expect(await claimRun(h.db, org, old?.id ?? '', now)).toBe(true);
    expect(await claimRun(h.db, org, old?.id ?? '', now)).toBe(false);
    expect(await planIn(org, now)).toEqual([]);
    expect(fresh?.queued).toBe(true);
  });

  it('never closes a run claimed late while it runs; finishing an interrupted run changes nothing', async () => {
    const org = 'org_late';
    const id = await createIn(
      org,
      { name: 'late', trigger: 'schedule', schedule: { cron: '0 6 * * *' } },
      at('2026-10-27T11:00:00Z'),
    );
    // Re-sent and claimed 25 minutes after it was queued: 40 minutes old, running for 15.
    const run = await manualRunIn(org, id, at('2026-10-27T11:20:00Z'));
    expect(await claimRun(h.db, org, run?.id ?? '', at('2026-10-27T11:45:00Z'))).toBe(true);
    expect(await closeStaleRuns(h.db, org, at('2026-10-27T12:00:00Z'))).toBe(0);
    // Still running 30 minutes after its claim: its worker is gone.
    expect(await closeStaleRuns(h.db, org, at('2026-10-27T12:16:00Z'))).toBe(1);
    // The lost worker comes back: its late outcome does not overwrite the interruption.
    expect(
      await finishRun(h.db, org, run?.id ?? '', at('2026-10-27T12:20:00Z'), {
        status: 'succeeded',
        output: 'late report',
      }),
    ).toBe(false);
    expect(
      (await runsOf(id)).map((r) => [r.status, r.resultCode, r.output, r.startedAt, r.finishedAt]),
    ).toEqual([
      ['failed', 'interrupted', null, at('2026-10-27T11:45:00Z'), at('2026-10-27T12:16:00Z')],
    ]);
  });

  it('disables a skill whose owner left, once, with a skipped run and an audit (P4-R19)', async () => {
    const t0 = at('2026-10-23T11:30:00Z');
    const r = await createSkill(h.db, member(), {
      document: serializeSkill({
        frontmatter: {
          name: 'leaver',
          description: 'Test',
          trigger: 'schedule',
          schedule: { cron: '0 * * * *' },
        } as never,
        instructions: 'Report.',
      }),
      now: t0,
    });
    if (!r.ok) throw new Error(r.code);
    await h.rawDb.delete(memberTable).where(eq(memberTable.id, 'm2'));
    try {
      expect(await plan(at('2026-10-23T12:01:00Z'))).toEqual([]);
      expect(await plan(at('2026-10-23T13:01:00Z'))).toEqual([]);
      expect((await runsOf(r.id)).map((x) => [x.status, x.resultCode])).toEqual([
        ['skipped', 'owner_left'],
      ]);
      const [row] = await h.rawDb.select().from(skills).where(eq(skills.id, r.id));
      expect(row?.enabled).toBe(false);
      const audits = await h.rawDb
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetId, r.id), eq(auditLog.action, 'skill.enabled_changed')));
      expect(audits.map((a) => [a.actorUserId, a.metadata])).toEqual([
        [null, { name: 'leaver', enabled: false, reason: 'owner_left' }],
      ]);
    } finally {
      await h.rawDb.insert(memberTable).values({
        id: 'm2',
        organizationId: 'org_a',
        userId: member().userId,
        role: 'viewer',
        createdAt: t0,
      });
    }
  });
});
