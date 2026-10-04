import { randomUUID } from 'node:crypto';
import {
  auditLog,
  deliveryChannels,
  member as memberTable,
  skillRuns,
  skills,
  withOrg,
} from '@agile/db';
import { createSkill, serializeSkill, setSkillVisibility } from '@agile/skills';
import { member, owner } from '@agile/sync/testing';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALERT_COOLDOWN_HOURS, planSkillRuns } from './plan';
import { claimRun, closeStaleRuns, createRun, finishRun, listRuns } from './runs';
import { startAutomationHarness } from './test-harness';

const MONDAY_7 = new Date('2026-10-05T07:00:00Z');
const at = (iso: string) => new Date(iso);

describe('planning background runs (schedules, alerts, limits)', () => {
  let h: Awaited<ReturnType<typeof startAutomationHarness>>;
  beforeAll(async () => {
    h = await startAutomationHarness();
  });
  afterAll(async () => h?.stop());

  const create = async (frontmatter: Record<string, unknown>, now = MONDAY_7) => {
    const r = await createSkill(h.db, owner(), {
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
  const runsOf = (skillId: string) =>
    h.rawDb.select().from(skillRuns).where(eq(skillRuns.skillId, skillId));
  const plan = (now: Date, dailyLimit = 50) =>
    planSkillRuns({ db: h.db, dailyLimit }, 'org_a', now);
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
    // The two runs planned above count against the day: a limit of 2 is reached.
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

  const disableAll = () => h.rawDb.update(skills).set({ enabled: false });
  const manualRun = (skillId: string, now: Date, dailyLimit = 50) =>
    withOrg(h.db, 'org_a', (tx) =>
      createRun(tx, 'org_a', { skillId, version: 1, trigger: 'manual', now, dailyLimit }),
    );

  it('fires an alert once when two ticks plan it at the same time (P4-R2)', async () => {
    await disableAll();
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
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let held = () => {};
    const holding = new Promise<void>((r) => {
      held = r;
    });
    const holder = h.rawDb.transaction(async (tx) => {
      await tx.select({ id: skills.id }).from(skills).where(eq(skills.id, id)).for('update');
      held();
      await gate;
    });
    await holding;
    const both = Promise.all([plan(now), plan(now)]);
    for (let i = 0; i < 400; i++) {
      const [row] = await h.db.execute<{ n: number }>(
        sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock'`,
      );
      if ((row?.n ?? 0) >= 2) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    release();
    await holder;
    const [a, b] = await both;
    expect([...a, ...b]).toHaveLength(1);
    expect(await runsOf(id)).toHaveLength(1);
    await disable(id);
  });

  it('keeps a board that starts matching during the cooldown able to fire later (P4-R10 L21)', async () => {
    await disableAll();
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
    await disable(id);
  });

  it('holds the daily limit when two runs are requested at the same time', async () => {
    await disableAll();
    const now = at('2026-11-30T12:00:00Z');
    const id = await create(
      { name: 'cap-race', trigger: 'schedule', schedule: { cron: '0 6 * * *' } },
      now,
    );
    await disable(id);
    // Later than every other run of this file: a limit of 1 leaves room for exactly one.
    const results = await Promise.all([manualRun(id, now, 1), manualRun(id, now, 1)]);
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

  it('snapshots the output and an in-workspace channel into the run (P4-R5)', async () => {
    await disableAll();
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
    await disableAll();
    const now = at('2026-10-26T12:00:00Z');
    const id = await create(
      { name: 'shared-report', trigger: 'schedule', schedule: { cron: '0 6 * * *' } },
      now,
    );
    await disable(id);
    expect((await setSkillVisibility(h.db, owner(), id, 'workspace')).ok).toBe(true);
    const run = await manualRun(id, now);
    await finishRun(h.db, 'org_a', run?.id ?? '', {
      status: 'succeeded',
      output: 'Live Jira report',
      deliveries: { email: 'sent' },
    });
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
    await disableAll();
    const now = at('2026-10-21T12:00:00Z');
    const id = await create(
      { name: 'lost', trigger: 'schedule', schedule: { cron: '0 6 * * *' } },
      now,
    );
    await disable(id);
    const old = await manualRun(id, at('2026-10-21T11:45:00Z'));
    const fresh = await manualRun(id, at('2026-10-21T11:55:00Z'));
    expect(await plan(now)).toEqual([old?.id]);
    // Every tick re-sends it while it waits; the worker's claim runs it once.
    expect(await plan(now)).toEqual([old?.id]);
    expect(await claimRun(h.db, 'org_a', old?.id ?? '')).toBe(true);
    expect(await claimRun(h.db, 'org_a', old?.id ?? '')).toBe(false);
    expect(await plan(now)).toEqual([]);
    expect(fresh?.queued).toBe(true);
  });

  it('disables a skill whose owner left, once, with a skipped run and an audit (P4-R19)', async () => {
    await disableAll();
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
        role: 'member',
        createdAt: t0,
      });
    }
  });
});
