import {
  agentUsage,
  deliveryChannels,
  member as memberTable,
  skillRuns,
  skills,
  withOrg,
} from '@agile/db';
import { createSkill, type SkillActor, serializeSkill } from '@agile/skills';
import { member, owner } from '@agile/sync/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { executeSkillRun } from './execute';
import { createRun } from './runs';
import { startAutomationHarness } from './test-harness';

const NOW = new Date('2026-10-05T08:00:00Z');

/** Database blips after a delivery went out (M1): `markChannel` and `finishRun` can be made to fail. */
const blips = vi.hoisted(() => ({ markChannel: 0, finishRun: 0 }));
vi.mock('@agile/notify', async (importOriginal) => {
  const real = await importOriginal<typeof import('@agile/notify')>();
  return {
    ...real,
    markChannel: async (...args: Parameters<typeof real.markChannel>) => {
      if (blips.markChannel > 0) {
        blips.markChannel--;
        throw new Error('connection reset');
      }
      return real.markChannel(...args);
    },
  };
});
vi.mock('./runs', async (importOriginal) => {
  const real = await importOriginal<typeof import('./runs')>();
  return {
    ...real,
    finishRun: async (...args: Parameters<typeof real.finishRun>) => {
      if (blips.finishRun > 0) {
        blips.finishRun--;
        throw new Error('connection reset');
      }
      return real.finishRun(...args);
    },
  };
});

describe('executing a run: owner, read-only report, delivery', () => {
  let h: Awaited<ReturnType<typeof startAutomationHarness>>;
  beforeAll(async () => {
    h = await startAutomationHarness();
  });
  afterAll(async () => h?.stop());

  const skillFor = async (
    actor: SkillActor,
    name: string,
    output: string,
    opts: { channelId?: string; locale?: 'en' | 'fr' } = {},
  ) => {
    const r = await createSkill(h.db, actor, {
      document: serializeSkill({
        frontmatter: {
          name,
          description: 'Weekly',
          trigger: 'schedule',
          schedule: { cron: '0 8 * * 1' },
          output: output as never,
        },
        instructions: 'Report on the boards.',
      }),
      channelId: opts.channelId ?? null,
      locale: opts.locale,
      now: NOW,
    });
    if (!r.ok) throw new Error(r.code);
    return r.id;
  };
  // Scheduled runs (one per scheduled time) under a high limit: this file records more runs than
  // one owner's "Run now" allowance and share of the default limit (P4-R30).
  let slot = 0;
  const queue = async (skillId: string, trigger: 'schedule' | 'alert' = 'schedule') => {
    const run = await withOrg(h.db, 'org_a', (tx) =>
      createRun(tx, 'org_a', {
        skillId,
        version: 1,
        trigger,
        scheduledFor: trigger === 'schedule' ? new Date(NOW.getTime() + ++slot * 60_000) : null,
        now: new Date(),
        dailyLimit: 1000,
        context: trigger === 'alert' ? { matches: [{ board: 'OPS Kanban', value: 9 }] } : {},
      }),
    );
    if (!run?.queued) throw new Error('no run');
    return run.id;
  };
  const runRow = async (id: string) =>
    (await h.rawDb.select().from(skillRuns).where(eq(skillRuns.id, id)))[0];
  const setOwnerRole = (role: string) =>
    h.rawDb
      .update(memberTable)
      .set({ role })
      .where(and(eq(memberTable.organizationId, 'org_a'), eq(memberTable.userId, owner().userId)));

  it("emails the report to the owner's account address only, in the owner's language", async () => {
    const id = await skillFor(owner(), 'weekly-mail', 'email', { locale: 'fr' });
    const runId = await queue(id);
    expect(await executeSkillRun(h.deps, 'org_a', runId)).toEqual({
      status: 'succeeded',
      deliveries: { email: 'sent' },
    });
    const mail = h.smtp.mails.at(-1);
    expect(mail?.to).toEqual(['pat@example.com']);
    expect(mail?.subject).toBe('Rapport : weekly-mail');
    expect(mail?.text).toContain('Report for weekly-mail: 2 boards checked.');
    expect(mail?.text).toContain('Vous recevez ce message');
    expect(mail?.html).toContain(`http://localhost:3200/skills/${id}`);
    expect(await runRow(runId)).toMatchObject({
      status: 'succeeded',
      resultCode: null,
      output: 'Report for weekly-mail: 2 boards checked.',
      deliveries: { email: 'sent' },
    });
    // Metered against the owner and the run (P4-R10 L6).
    const usage = await h.rawDb
      .select({ userId: agentUsage.userId, orgId: agentUsage.orgId })
      .from(agentUsage)
      .where(eq(agentUsage.skillRunId, runId));
    expect(usage).toEqual([{ userId: owner().userId, orgId: 'org_a' }]);
    // Claimed once: a duplicate job does nothing.
    expect(await executeSkillRun(h.deps, 'org_a', runId)).toEqual({ status: 'not_claimed' });
    expect(h.smtp.mails.filter((m) => m.subject.includes('weekly-mail'))).toHaveLength(1);
  });

  it('posts alerts to the Slack channel with the triggering facts given to the model', async () => {
    const id = await skillFor(owner(), 'wip-slack', 'slack', { channelId: h.slackChannelId });
    const runId = await queue(id, 'alert');
    expect(await executeSkillRun(h.deps, 'org_a', runId)).toEqual({
      status: 'succeeded',
      deliveries: { slack: 'sent' },
    });
    expect(h.hook.posts.at(-1)).toMatchObject({
      path: '/services/T/B/x',
      body: { text: 'Alert: wip-slack', unfurl_links: false },
    });
    const sent = h.llm.requests.find((r) =>
      r.messages.some((m) => String(m.content).includes('<skill name="wip-slack">')),
    );
    expect(JSON.stringify(sent?.messages)).toContain('skill_trigger');
  });

  it('keeps the report when delivery fails, with the code on the run and the channel', async () => {
    const id = await skillFor(owner(), 'broken-post', 'slack', { channelId: h.brokenChannelId });
    h.hook.failing.add('/services/T/B/broken');
    const runId = await queue(id);
    expect(await executeSkillRun(h.deps, 'org_a', runId)).toEqual({
      status: 'succeeded',
      deliveries: { slack: 'rejected' },
    });
    expect(await runRow(runId)).toMatchObject({
      resultCode: 'delivery_failed',
      output: 'Report for broken-post: 2 boards checked.',
    });
    const [channel] = await h.rawDb
      .select()
      .from(deliveryChannels)
      .where(eq(deliveryChannels.id, h.brokenChannelId));
    expect(channel?.lastError).toBe('rejected');
  });

  it('delivers from the run snapshot, not from an edit made after it was queued (P4-R5)', async () => {
    const id = await skillFor(owner(), 'snapshot-post', 'slack', { channelId: h.slackChannelId });
    const runId = await queue(id);
    // Edited while the run waits: another channel, another output.
    await h.rawDb
      .update(skills)
      .set({ output: 'email', channelId: h.brokenChannelId })
      .where(eq(skills.id, id));
    const mails = h.smtp.mails.length;
    const posts = h.hook.posts.length;
    expect(await executeSkillRun(h.deps, 'org_a', runId)).toEqual({
      status: 'succeeded',
      deliveries: { slack: 'sent' },
    });
    expect(h.hook.posts.slice(posts)).toEqual([
      expect.objectContaining({ path: '/services/T/B/x' }),
    ]);
    expect(h.smtp.mails.length).toBe(mails);
  });

  it("emails through the workspace's SMTP server snapshotted into the run (P4-R5, M5)", async () => {
    const id = await skillFor(owner(), 'smtp-snapshot', 'email');
    const runId = await queue(id);
    const [smtp] = await h.rawDb
      .select({ id: deliveryChannels.id })
      .from(deliveryChannels)
      .where(eq(deliveryChannels.kind, 'smtp'));
    expect((await runRow(runId))?.channelId).toBe(smtp?.id);
    // A run recorded while the workspace had no SMTP server is not sent through a later one.
    const without = await queue(id);
    await h.rawDb.update(skillRuns).set({ channelId: null }).where(eq(skillRuns.id, without));
    const mails = h.smtp.mails.length;
    expect(await executeSkillRun(h.deps, 'org_a', without)).toEqual({
      status: 'succeeded',
      deliveries: { email: 'no_channel' },
    });
    expect(h.smtp.mails.length).toBe(mails);
  });

  it('never records a sent report as failed when the database blips afterwards (M1)', async () => {
    const id = await skillFor(owner(), 'blip-post', 'slack', { channelId: h.slackChannelId });
    const errors: string[] = [];
    const deps = { ...h.deps, onError: (_e: unknown, code: string) => errors.push(code) };
    // Recording the channel's outcome fails: the post went out, the run says so.
    blips.markChannel = 1;
    const marked = await queue(id);
    expect(await executeSkillRun(deps, 'org_a', marked)).toEqual({
      status: 'succeeded',
      deliveries: { slack: 'sent' },
    });
    expect(await runRow(marked)).toMatchObject({ status: 'succeeded', resultCode: null });
    expect(errors).toEqual(['channel_mark_failed']);
    // Storing the outcome fails once: retried.
    blips.finishRun = 1;
    const once = await queue(id);
    expect(await executeSkillRun(deps, 'org_a', once)).toMatchObject({ status: 'succeeded' });
    expect(await runRow(once)).toMatchObject({
      status: 'succeeded',
      deliveries: { slack: 'sent' },
    });
    // Fails twice: reported, never turned into a failed run (the stale-run sweep closes it).
    blips.finishRun = 2;
    const twice = await queue(id);
    const posts = h.hook.posts.length;
    expect(await executeSkillRun(deps, 'org_a', twice)).toEqual({
      status: 'succeeded',
      deliveries: { slack: 'sent' },
    });
    expect(h.hook.posts.length).toBe(posts + 1);
    expect(errors).toEqual(['channel_mark_failed', 'finish_failed']);
    expect(await runRow(twice)).toMatchObject({ status: 'running' });
  });

  it('ends a run as interrupted when the worker stops during its delivery (M3)', async () => {
    const id = await skillFor(owner(), 'stopping-post', 'slack', { channelId: h.slackChannelId });
    const runId = await queue(id);
    const [before] = await h.rawDb
      .select({ lastError: deliveryChannels.lastError })
      .from(deliveryChannels)
      .where(eq(deliveryChannels.id, h.slackChannelId));
    h.hook.stalling.add('/services/T/B/x');
    try {
      const stop = new AbortController();
      const posts = h.hook.posts.length;
      const running = executeSkillRun(h.deps, 'org_a', runId, stop.signal);
      // The post reached the platform, which does not answer: the worker stops now.
      for (let i = 0; i < 200 && h.hook.posts.length === posts; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(h.hook.posts.length).toBe(posts + 1);
      stop.abort();
      expect(await running).toEqual({ status: 'failed', code: 'interrupted' });
    } finally {
      h.hook.stalling.delete('/services/T/B/x');
    }
    // Finished (not left running), with its report; the channel is not blamed.
    expect(await runRow(runId)).toMatchObject({
      status: 'failed',
      resultCode: 'interrupted',
      output: 'Report for stopping-post: 2 boards checked.',
      deliveries: {},
    });
    expect((await runRow(runId))?.finishedAt).not.toBeNull();
    const [after] = await h.rawDb
      .select({ lastError: deliveryChannels.lastError })
      .from(deliveryChannels)
      .where(eq(deliveryChannels.id, h.slackChannelId));
    expect(after?.lastError).toBe(before?.lastError);
  });

  it('posts nothing for an owner who is no longer an owner or admin (P4-R4)', async () => {
    const id = await skillFor(owner(), 'demoted-post', 'slack', { channelId: h.slackChannelId });
    const runId = await queue(id);
    await setOwnerRole('member');
    try {
      const posts = h.hook.posts.length;
      const calls = h.llm.requests.length;
      expect(await executeSkillRun(h.deps, 'org_a', runId)).toEqual({
        status: 'failed',
        code: 'forbidden_role',
      });
      expect(h.hook.posts.length).toBe(posts);
      // Refused before the model: nothing is spent on a report that cannot go out.
      expect(h.llm.requests.length).toBe(calls);
      expect(await runRow(runId)).toMatchObject({
        status: 'failed',
        resultCode: 'forbidden_role',
        output: null,
      });
    } finally {
      await setOwnerRole('owner');
    }
  });

  it('keeps chat and dashboard-card reports on the run only', async () => {
    const id = await skillFor(owner(), 'card', 'dashboard_card');
    const runId = await queue(id);
    expect(await executeSkillRun(h.deps, 'org_a', runId)).toEqual({
      status: 'succeeded',
      deliveries: {},
    });
  });

  it('fails with a fixed code when the run throws (e.g. the skills store or keyring)', async () => {
    const id = await skillFor(owner(), 'throwing-run', 'email');
    const runId = await queue(id);
    const errors: string[] = [];
    const mails = h.smtp.mails.length;
    expect(
      await executeSkillRun(
        {
          ...h.deps,
          // Unreadable secrets: loading the model throws.
          keyring: { currentVersion: 9, keys: new Map([[9, Buffer.alloc(32, 1)]]) },
          onError: (_e, code) => errors.push(code),
        },
        'org_a',
        runId,
      ),
    ).toEqual({ status: 'failed', code: 'internal_error' });
    expect(errors).toContain('skill_run_failed');
    expect(await runRow(runId)).toMatchObject({ status: 'failed', resultCode: 'internal_error' });
    expect(h.smtp.mails.length).toBe(mails);
  });

  it('ends a run as interrupted when the worker stops before it starts', async () => {
    const id = await skillFor(owner(), 'stopped-run', 'chat');
    const runId = await queue(id);
    const calls = h.llm.requests.length;
    expect(await executeSkillRun(h.deps, 'org_a', runId, AbortSignal.abort())).toEqual({
      status: 'failed',
      code: 'interrupted',
    });
    expect(h.llm.requests.length).toBe(calls);
  });

  it('skips disabled skills and owners who left; never runs as anyone else', async () => {
    const off = await skillFor(owner(), 'switched-off', 'chat');
    await h.rawDb.update(skills).set({ enabled: false }).where(eq(skills.id, off));
    const offRun = await queue(off);
    expect(await executeSkillRun(h.deps, 'org_a', offRun)).toEqual({
      status: 'skipped',
      code: 'disabled',
    });
    const leaver = await skillFor(member(), 'leaver-report', 'email');
    await h.rawDb
      .delete(memberTable)
      .where(and(eq(memberTable.organizationId, 'org_a'), eq(memberTable.userId, member().userId)));
    const before = h.smtp.mails.length;
    const leaverRun = await queue(leaver);
    expect(await executeSkillRun(h.deps, 'org_a', leaverRun)).toEqual({
      status: 'skipped',
      code: 'owner_left',
    });
    expect(h.smtp.mails.length).toBe(before);
    expect(await runRow(leaverRun)).toMatchObject({ status: 'skipped', resultCode: 'owner_left' });
  });

  it('reports a model failure on the run, delivering nothing', async () => {
    const id = await skillFor(owner(), 'no-model', 'email');
    const runId = await queue(id);
    expect(await executeSkillRun(h.deps, 'org_b', runId)).toEqual({ status: 'not_claimed' });
    const before = h.smtp.mails.length;
    expect(
      await executeSkillRun(
        {
          ...h.deps,
          createModel: () => {
            throw new Error('boom');
          },
        },
        'org_a',
        runId,
      ),
    ).toEqual({ status: 'failed', code: 'model_failed' });
    expect(h.smtp.mails.length).toBe(before);
  });
});
