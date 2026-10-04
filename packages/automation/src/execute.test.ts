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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeSkillRun } from './execute';
import { createRun } from './runs';
import { startAutomationHarness } from './test-harness';

const NOW = new Date('2026-10-05T08:00:00Z');

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
  const queue = async (skillId: string, trigger: 'manual' | 'alert' = 'manual') => {
    const run = await withOrg(h.db, 'org_a', (tx) =>
      createRun(tx, 'org_a', {
        skillId,
        version: 1,
        trigger,
        now: new Date(),
        dailyLimit: 50,
        context: trigger === 'alert' ? { matches: [{ board: 'OPS Kanban', value: 9 }] } : {},
      }),
    );
    if (!run) throw new Error('no run');
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
