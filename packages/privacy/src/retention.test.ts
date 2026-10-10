import { randomUUID } from 'node:crypto';
import {
  agentAttachments,
  agentConversations,
  agentMessages,
  agentUsage,
  auditLog,
  createDb,
  deletedOrganizations,
  invitation,
  jiraConnections,
  jiraSyncRuns,
  mcpRateBuckets,
  mcpTokens,
  organization,
  personalDataExports,
  session,
  signInAttempts,
  skillBuilderCalls,
  skillRuns,
  skills,
  stripeEvents,
  user,
  verification,
  withOrg,
} from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyRetention,
  INVITATIONS_RETENTION_DAYS,
  PERSONAL_DATA_EXPORTS_RETENTION_DAYS,
  RETENTION_BATCH_SIZE,
  runRetention,
  SIGN_IN_ATTEMPTS_RETENTION_DAYS,
  STRIPE_EVENTS_RETENTION_DAYS,
} from './retention';
import {
  DEFAULT_SETTINGS,
  getWorkspaceSettings,
  RETENTION_BOUNDS,
  SettingsError,
  updateWorkspaceSettings,
} from './settings';

const NOW = new Date('2026-10-04T12:00:00Z');
const HOUR = 3_600_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const admin = { orgId: 'org_a', userId: 'user_admin', roles: ['admin'] };
const NONE = {
  conversations: 0,
  skillRuns: 0,
  usage: 0,
  audit: 0,
  builderCalls: 0,
  syncRuns: 0,
  mcpTokens: 0,
  mcpRateBuckets: 0,
};

describe('retention and workspace settings', () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createDb>;
  let raw: ReturnType<typeof createDb>;

  const newSkill = async (orgId: string, name: string) => {
    const [skill] = await raw.db
      .insert(skills)
      .values({
        orgId,
        ownerUserId: 'u1',
        name,
        description: 'd',
        trigger: 'schedule',
        output: 'email',
      })
      .returning();
    return skill?.id ?? '';
  };
  const finishedRun = (orgId: string, skillId: string | null, createdAt: Date) =>
    raw.db.insert(skillRuns).values({
      orgId,
      skillId,
      ownerUserId: 'u1',
      version: 1,
      trigger: 'schedule',
      status: 'succeeded',
      output: 'report',
      createdAt,
    });
  const newConnection = async (orgId: string) => {
    const id = randomUUID();
    await raw.db.insert(jiraConnections).values({
      id,
      orgId,
      name: `Jira ${id}`,
      deployment: 'datacenter',
      authType: 'pat',
      baseUrl: `https://jira.example/${id}`,
      secret: 's1.x.y.z',
      createdBy: 'u1',
    });
    return id;
  };
  const syncRun = (
    orgId: string,
    connectionId: string,
    age: number,
    status: 'ok' | 'error' | 'running' = 'ok',
  ) =>
    raw.db.insert(jiraSyncRuns).values({
      orgId,
      connectionId,
      trigger: 'schedule',
      mode: 'incremental',
      status,
      startedAt: daysAgo(age),
    });

  /** Rows of every age in one workspace (written as the owner: timestamps in the past). */
  const seed = async (orgId: string) => {
    for (const age of [10, 200, 800]) {
      const [c] = await raw.db
        .insert(agentConversations)
        .values({ orgId, userId: 'u1', title: `${age}`, updatedAt: daysAgo(age) })
        .returning();
      await raw.db.insert(agentMessages).values({
        orgId,
        conversationId: c?.id ?? '',
        id: `m${orgId}${age}`,
        seq: 0,
        role: 'user',
        parts: [],
      });
      // An image goes with its conversation.
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await raw.db.insert(agentAttachments).values({
        orgId,
        userId: 'u1',
        conversationId: c?.id ?? '',
        mediaType: 'image/png',
        byteSize: png.length,
        sha256: 'x',
        bytes: png,
      });
      await raw.db.insert(agentUsage).values({
        orgId,
        userId: 'u1',
        provider: 'openai',
        model: 'm',
        createdAt: daysAgo(age),
      });
      await raw.db.insert(auditLog).values({ orgId, action: `t${age}`, createdAt: daysAgo(age) });
    }
    // A skill with a finished run of each age, plus old runs still queued or running (never deleted).
    const digest = await newSkill(orgId, 'digest');
    for (const age of [10, 200, 800]) await finishedRun(orgId, digest, daysAgo(age));
    for (const status of ['queued', 'running'] as const) {
      await raw.db.insert(skillRuns).values({
        orgId,
        skillId: digest,
        ownerUserId: 'u1',
        version: 1,
        trigger: 'manual',
        status,
        createdAt: daysAgo(800),
      });
    }
    // A skill whose only (old) run is its latest: kept. A run whose skill is gone: deleted.
    await finishedRun(orgId, await newSkill(orgId, 'quiet'), daysAgo(800));
    await finishedRun(orgId, null, daysAgo(800));
    // Skill-builder reservations (P4-R29): only the last hour counts toward the limit.
    for (const age of [0, 10]) {
      await raw.db
        .insert(skillBuilderCalls)
        .values({ orgId, userId: 'u1', createdAt: daysAgo(age) });
    }
    // Sync runs: older than 90 days go, except each connection's latest finished run.
    const busy = await newConnection(orgId);
    await syncRun(orgId, busy, 10);
    await syncRun(orgId, busy, 100);
    await syncRun(orgId, busy, 200, 'error');
    await syncRun(orgId, busy, 300);
    await syncRun(orgId, await newConnection(orgId), 400);
  };
  const count = async (orgId: string) => {
    const [row] = (await raw.db.execute(sql`
      select (select count(*)::int from agent_conversations where org_id = ${orgId}) as conversations,
             (select count(*)::int from agent_messages where org_id = ${orgId}) as messages,
             (select count(*)::int from agent_attachments where org_id = ${orgId}) as attachments,
             (select count(*)::int from agent_usage where org_id = ${orgId}) as usage,
             (select count(*)::int from skill_runs where org_id = ${orgId}) as runs,
             (select count(*)::int from skill_builder_calls where org_id = ${orgId}) as builder,
             (select count(*)::int from jira_sync_runs where org_id = ${orgId}) as sync,
             (select count(*)::int from audit_log where org_id = ${orgId} and action like 't%') as audit
    `)) as unknown as Record<string, number>[];
    return row;
  };
  const oldConversations = async (orgId: string, n: number) => {
    for (let i = 0; i < n; i++) {
      await raw.db
        .insert(agentConversations)
        .values({ orgId, userId: 'u1', title: `old ${i}`, updatedAt: daysAgo(400) });
    }
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = createDb(tdb.appUrl, { max: 2 });
    raw = createDb(tdb.ownerUrl, { max: 1 });
    await raw.db.insert(organization).values(
      ['org_a', 'org_b', 'org_s', 'org_min', 'org_big', 'org_abort'].map((id) => ({
        id,
        name: id,
        slug: id,
        createdAt: NOW,
      })),
    );
    await seed('org_a');
    await seed('org_b');
  });
  afterAll(async () => {
    await app?.close();
    await raw?.close();
    await tdb?.stop();
  });

  it('uses the defaults until an owner or admin changes them, and audits the change', async () => {
    expect(await getWorkspaceSettings(app.db, 'org_a')).toEqual(DEFAULT_SETTINGS);
    await expect(
      updateWorkspaceSettings(app.db, { ...admin, roles: ['manager'] }, { usageRetentionDays: 60 }),
    ).rejects.toMatchObject({ code: 'forbidden_role' });
    for (const bad of [
      { auditRetentionDays: 30 }, // below the 90-day floor
      { conversationRetentionDays: 0 },
      { usageRetentionDays: 99_999 },
      { unknown: 1 },
      {}, // nothing to change
    ]) {
      await expect(updateWorkspaceSettings(app.db, admin, bad)).rejects.toMatchObject({
        code: 'invalid_input',
      });
    }
    const s = await updateWorkspaceSettings(app.db, admin, { conversationRetentionDays: 30 });
    expect(s).toEqual({ ...DEFAULT_SETTINGS, conversationRetentionDays: 30 });
    const [entry] = await raw.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'workspace.settings_changed'));
    expect(entry).toMatchObject({
      orgId: 'org_a',
      actorUserId: 'user_admin',
      metadata: { conversationRetentionDays: { from: 180, to: 30 } },
    });
    expect(new SettingsError('invalid_input')).toBeInstanceOf(Error);
  });

  it('never loses a change when two admins save at the same time', async () => {
    const actor = { ...admin, orgId: 'org_s' };
    await Promise.all([
      updateWorkspaceSettings(app.db, actor, { usageRetentionDays: 60 }),
      updateWorkspaceSettings(app.db, actor, { auditRetentionDays: 400 }),
      updateWorkspaceSettings(app.db, actor, { externalMcpEnabled: true }),
    ]);
    expect(await getWorkspaceSettings(app.db, 'org_s')).toEqual({
      ...DEFAULT_SETTINGS,
      usageRetentionDays: 60,
      auditRetentionDays: 400,
      externalMcpEnabled: true,
    });
  });

  it('keeps what the daily skill caps and the builder limit count, even at the minimums', async () => {
    const actor = { ...admin, orgId: 'org_min' };
    await updateWorkspaceSettings(app.db, actor, {
      conversationRetentionDays: RETENTION_BOUNDS.conversationRetentionDays.min,
      usageRetentionDays: RETENTION_BOUNDS.usageRetentionDays.min,
      auditRetentionDays: RETENTION_BOUNDS.auditRetentionDays.min,
    });
    // Skill caps count finished runs of the last 24 h (not the latest, so only age protects it);
    // the builder limit counts reservations of the last hour.
    const skill = await newSkill('org_min', 'capped');
    const justBefore = new Date(NOW.getTime() - 24 * HOUR + 60_000);
    await finishedRun('org_min', skill, justBefore);
    await finishedRun('org_min', skill, new Date(NOW.getTime() - HOUR));
    await raw.db.insert(skillBuilderCalls).values({
      orgId: 'org_min',
      userId: 'u1',
      createdAt: new Date(NOW.getTime() - HOUR + 60_000),
    });
    await raw.db.insert(agentUsage).values({
      orgId: 'org_min',
      userId: 'u1',
      provider: 'openai',
      model: 'm',
      createdAt: justBefore,
    });
    expect(await applyRetention(app.db, 'org_min', NOW)).toEqual(NONE);
    expect(await count('org_min')).toMatchObject({ runs: 2, builder: 1, usage: 1 });
  });

  it("deletes what is older than the workspace's retention, and only in that workspace", async () => {
    const all = {
      conversations: 3,
      messages: 3,
      attachments: 3,
      usage: 3,
      runs: 7,
      builder: 2,
      sync: 5,
      audit: 3,
    };
    expect(await count('org_a')).toEqual(all);
    // org_a: conversations and skill runs 30 days, usage 730, audit 365; builder calls 7 days,
    // sync runs 90 days.
    expect(await applyRetention(app.db, 'org_a', NOW)).toEqual({
      conversations: 2,
      // digest's 200- and 800-day-old runs and the orphan; not quiet's only run (its latest).
      skillRuns: 3,
      usage: 1,
      audit: 1,
      builderCalls: 1,
      // 100, 200 (error) and 300 days; not the 10-day run, not the other connection's only run.
      syncRuns: 3,
      mcpTokens: 0,
      mcpRateBuckets: 0,
    });
    // The queued and running runs stay, whatever their age.
    expect(await count('org_a')).toEqual({
      conversations: 1,
      messages: 1,
      attachments: 1,
      usage: 2,
      runs: 4,
      builder: 1,
      sync: 2,
      audit: 2,
    });
    const kept = await raw.db
      .select({ status: skillRuns.status, skillId: skillRuns.skillId })
      .from(skillRuns)
      .where(eq(skillRuns.orgId, 'org_a'));
    expect(kept.filter((r) => r.status === 'succeeded')).toHaveLength(2);
    expect(kept.every((r) => r.skillId !== null)).toBe(true);
    expect(await count('org_b')).toEqual(all);
    // Idempotent: a second run the same day deletes nothing more.
    expect(await applyRetention(app.db, 'org_a', NOW)).toEqual(NONE);
  });

  it('deletes in batches until a large backlog is gone', async () => {
    await raw.db.execute(sql`
      insert into agent_usage (org_id, user_id, provider, model, created_at)
      select 'org_big', 'u1', 'openai', 'm', ${daysAgo(800).toISOString()}::timestamptz
      from generate_series(1, ${RETENTION_BATCH_SIZE + 1})
    `);
    await raw.db.insert(auditLog).values(
      [400, 401, 402, 403, 404].map((age) => ({
        orgId: 'org_big',
        action: `t${age}`,
        createdAt: daysAgo(age),
      })),
    );
    await oldConversations('org_big', 5);
    expect(await applyRetention(app.db, 'org_big', NOW)).toEqual({
      ...NONE,
      usage: RETENTION_BATCH_SIZE + 1,
      audit: 5,
      conversations: 5,
    });
    // Small batches drain the same way (the audit purge is called until it has nothing left).
    await raw.db.insert(auditLog).values(
      [400, 401, 402].map((age) => ({
        orgId: 'org_big',
        action: `t${age}`,
        createdAt: daysAgo(age),
      })),
    );
    expect(await applyRetention(app.db, 'org_big', NOW, { batchSize: 2 })).toEqual({
      ...NONE,
      audit: 3,
    });
    expect(await count('org_big')).toMatchObject({ usage: 0, audit: 0, conversations: 0 });
  });

  it('drops MCP rate windows after a day and tokens revoked or expired 90 days ago', async () => {
    const token = (name: string, expiresAt: Date, revokedAt: Date | null = null) => ({
      orgId: 'org_mcp',
      userId: 'u1',
      name,
      tokenHash: `h_${name}`,
      prefix: 'acp_org_mcp.abcd',
      expiresAt,
      revokedAt,
    });
    await raw.db
      .insert(mcpTokens)
      .values([
        token('active', daysAgo(-30)),
        token('revoked_recently', daysAgo(-30), daysAgo(10)),
        token('revoked_long_ago', daysAgo(-30), daysAgo(91)),
        token('expired_recently', daysAgo(10)),
        token('expired_long_ago', daysAgo(91)),
        { ...token('other_workspace', daysAgo(200)), orgId: 'org_mcp_other' },
      ]);
    await raw.db.insert(mcpRateBuckets).values([
      { orgId: 'org_mcp', userId: 'u1', windowStart: new Date(NOW.getTime() - HOUR), count: 3 },
      { orgId: 'org_mcp', userId: 'u1', windowStart: daysAgo(2), count: 9 },
      { orgId: 'org_mcp', userId: 'u2', windowStart: daysAgo(3), count: 1 },
      { orgId: 'org_mcp_other', userId: 'u1', windowStart: daysAgo(3), count: 1 },
    ]);
    expect(await applyRetention(app.db, 'org_mcp', NOW, { batchSize: 1 })).toEqual({
      ...NONE,
      mcpTokens: 2,
      mcpRateBuckets: 2,
    });
    const names = (await raw.db.select().from(mcpTokens)).map((t) => t.name).sort();
    expect(names).toEqual(['active', 'expired_recently', 'other_workspace', 'revoked_recently']);
    const windows = await raw.db.select().from(mcpRateBuckets);
    expect(windows.map((w) => `${w.orgId}:${w.count}`).sort()).toEqual([
      'org_mcp:3',
      'org_mcp_other:1',
    ]);
  });

  it('stops between batches when the worker shuts down during a run', async () => {
    await oldConversations('org_abort', 5);
    // Not stopped when checked before the first batch, stopped at every later check.
    let checks = 0;
    const signal = {
      get aborted() {
        checks++;
        return checks > 1;
      },
    } as AbortSignal;
    expect(await applyRetention(app.db, 'org_abort', NOW, { batchSize: 2, signal })).toEqual({
      ...NONE,
      conversations: 2,
    });
    expect((await count('org_abort'))?.conversations).toBe(3);
  });

  it('only purges audit entries older than 90 days, of the current workspace, with a cutoff', async () => {
    // No direct DELETE for the app role (0001): only through purge_audit_log.
    await expect(
      withOrg(app.db, 'org_b', (tx) => tx.delete(auditLog).where(eq(auditLog.orgId, 'org_b'))),
    ).rejects.toThrow();
    // Bound to the caller's workspace (P5-R35a), and a cutoff is required (LEAST ignores NULL).
    await expect(
      withOrg(app.db, 'org_a', (tx) =>
        tx.execute(sql`select purge_audit_log('org_b', now() + interval '1 day', 10)`),
      ),
    ).rejects.toThrow();
    await expect(
      withOrg(app.db, 'org_b', (tx) => tx.execute(sql`select purge_audit_log('org_b', null, 10)`)),
    ).rejects.toThrow();
    await expect(
      withOrg(app.db, 'org_b', (tx) =>
        tx.execute(sql`select purge_audit_log('org_b', now(), null)`),
      ),
    ).rejects.toThrow();
    // At most p_limit rows per call; never the 10-day-old entry.
    const purge = () =>
      withOrg(app.db, 'org_b', async (tx) => {
        const [r] = await tx.execute<{ n: number }>(
          sql`select purge_audit_log('org_b', now() + interval '1 day', 1) as n`,
        );
        return r?.n;
      });
    expect([await purge(), await purge(), await purge()]).toEqual([1, 1, 0]);
    const left = await raw.db.select().from(auditLog).where(eq(auditLog.orgId, 'org_b'));
    expect(left.map((r) => r.action)).toEqual(['t10']);
    expect((await count('org_a'))?.audit).toBe(2);
  });

  it('stops before the first workspace when the worker is already stopping', async () => {
    const stop = new AbortController();
    stop.abort();
    expect(await runRetention(app.db, { now: NOW, signal: stop.signal })).toEqual({
      workspaces: 0,
      failed: { workspaces: 0, deletedOrgs: 0, global: 0 },
      deletedPurged: 0,
      deletedUsage: 0,
      sessions: 0,
      verifications: 0,
      invitations: 0,
      personalDataExports: 0,
      stripeEvents: 0,
      signInAttempts: 0,
      interrupted: true,
    });
  });

  it('purges expired sign-in data and deleted workspaces’ audit trails', async () => {
    await raw.db.insert(auditLog).values([
      { orgId: 'org_gone', action: 'organization.deleted', createdAt: daysAgo(120) },
      { orgId: 'org_recent', action: 'organization.deleted', createdAt: daysAgo(120) },
      { orgId: 'org_a', action: 'kept', createdAt: daysAgo(120) },
    ]);
    await raw.db.insert(deletedOrganizations).values([
      { deletedOrgId: 'org_gone', deletedAt: daysAgo(100) },
      { deletedOrgId: 'org_recent', deletedAt: daysAgo(10) },
      // Still a workspace (a stale or forged entry): never purged through this path.
      { deletedOrgId: 'org_a', deletedAt: daysAgo(100) },
    ]);
    // Sessions and verifications more than a day past expiry go (timestamp without time zone, UTC).
    await raw.db.insert(user).values({
      id: 'u1',
      name: 'U',
      email: 'u1@example.com',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const stamp = { createdAt: NOW, updatedAt: NOW };
    await raw.db.insert(session).values([
      { id: 's_old', token: 't1', userId: 'u1', expiresAt: daysAgo(2), ...stamp },
      {
        id: 's_grace',
        token: 't2',
        userId: 'u1',
        expiresAt: new Date(NOW.getTime() - HOUR),
        ...stamp,
      },
      { id: 's_live', token: 't3', userId: 'u1', expiresAt: daysAgo(-7), ...stamp },
    ]);
    await raw.db.insert(verification).values([
      { id: 'v_old', identifier: 'i', value: 'v', expiresAt: daysAgo(3), ...stamp },
      { id: 'v_live', identifier: 'i', value: 'v', expiresAt: daysAgo(-1), ...stamp },
    ]);

    const result = await runRetention(app.db, { now: NOW });
    expect(result).toEqual({
      workspaces: 6,
      failed: { workspaces: 0, deletedOrgs: 0, global: 0 },
      deletedPurged: 1,
      deletedUsage: 0,
      sessions: 1,
      verifications: 1,
      invitations: 0,
      personalDataExports: 0,
      stripeEvents: 0,
      signInAttempts: 0,
      interrupted: false,
    });
    const remaining = await raw.db.select({ org: auditLog.orgId }).from(auditLog);
    expect(remaining.map((r) => r.org)).not.toContain('org_gone');
    expect(remaining.map((r) => r.org)).toContain('org_recent');
    expect((await raw.db.select().from(auditLog).where(eq(auditLog.action, 'kept'))).length).toBe(
      1,
    );
    expect(
      (await raw.db.select().from(deletedOrganizations)).map((r) => r.deletedOrgId).sort(),
    ).toEqual(['org_a', 'org_recent']);
    expect((await raw.db.select({ id: session.id }).from(session)).map((r) => r.id).sort()).toEqual(
      ['s_grace', 's_live'],
    );
    expect(
      (await raw.db.select({ id: verification.id }).from(verification)).map((r) => r.id),
    ).toEqual(['v_live']);
  });

  it('deletes answered invitations and long-expired pending ones, in batches (P5-R45)', async () => {
    expect(INVITATIONS_RETENTION_DAYS).toBe(30);
    await raw.db.insert(user).values({
      id: 'u_inviter',
      name: 'Inviter',
      email: 'inviter@example.com',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const inv = (id: string, status: string, createdDaysAgo: number, expiresDaysAgo: number) => ({
      id,
      organizationId: 'org_a',
      email: `${id}@example.com`,
      role: 'viewer',
      status,
      createdAt: daysAgo(createdDaysAgo),
      expiresAt: daysAgo(expiresDaysAgo),
      inviterId: 'u_inviter',
    });
    await raw.db
      .insert(invitation)
      .values([
        inv('i_accepted_old', 'accepted', 40, 38),
        inv('i_rejected_old', 'rejected', 31, 29),
        inv('i_canceled_old', 'canceled', 45, 43),
        inv('i_expired_old', 'expired', 50, 48),
        inv('i_canceled_recent', 'canceled', 10, 8),
        inv('i_pending_long_expired', 'pending', 40, 31),
        inv('i_pending_recently_expired', 'pending', 40, 29),
        inv('i_pending_live', 'pending', 1, -1),
      ]);
    const result = await runRetention(app.db, { now: NOW, batchSize: 2 });
    expect(result.invitations).toBe(5);
    expect(result.failed.global).toBe(0);
    const left = await raw.db
      .select({ id: invitation.id })
      .from(invitation)
      .where(eq(invitation.organizationId, 'org_a'));
    expect(left.map((r) => r.id).sort()).toEqual([
      'i_canceled_recent',
      'i_pending_live',
      'i_pending_recently_expired',
    ]);
  });

  it('forgets export and deletion-attempt records and Stripe event ids after 30 days, in batches', async () => {
    expect(PERSONAL_DATA_EXPORTS_RETENTION_DAYS).toBe(30);
    expect(STRIPE_EVENTS_RETENTION_DAYS).toBe(30);
    await raw.db.insert(user).values({
      id: 'u_exports',
      name: 'E',
      email: 'exports@example.com',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const record = (kind: string, days: number) => ({
      userId: 'u_exports',
      kind,
      startedAt: daysAgo(days),
      finishedAt: daysAgo(days),
    });
    await raw.db
      .insert(personalDataExports)
      .values([
        record('personal', 31),
        record('audit', 40),
        record('deletion', 60),
        record('personal', 29),
        record('deletion', 1),
      ]);
    await raw.db.insert(stripeEvents).values([
      { id: 'evt_old_1', type: 'x', receivedAt: daysAgo(31) },
      { id: 'evt_old_2', type: 'x', receivedAt: daysAgo(45) },
      { id: 'evt_old_3', type: 'x', receivedAt: daysAgo(90) },
      { id: 'evt_recent', type: 'x', receivedAt: daysAgo(29) },
    ]);
    const result = await runRetention(app.db, { now: NOW, batchSize: 2 });
    expect(result).toMatchObject({ personalDataExports: 3, stripeEvents: 3 });
    expect(result.failed.global).toBe(0);
    const left = await raw.db
      .select({ startedAt: personalDataExports.startedAt })
      .from(personalDataExports)
      .where(eq(personalDataExports.userId, 'u_exports'));
    expect(left.map((r) => r.startedAt.getTime()).sort()).toEqual(
      [daysAgo(29), daysAgo(1)].map((d) => d.getTime()).sort(),
    );
    expect(
      (await raw.db.select({ id: stripeEvents.id }).from(stripeEvents)).map((r) => r.id),
    ).toEqual(['evt_recent']);
  });

  it('forgets sign-in attempt windows a day after they started, in batches', async () => {
    expect(SIGN_IN_ATTEMPTS_RETENTION_DAYS).toBe(1);
    await raw.db.insert(signInAttempts).values([
      { keyHash: 'k_old_1', attempts: 3, windowStartedAt: daysAgo(2) },
      { keyHash: 'k_old_2', attempts: 10, windowStartedAt: new Date(NOW.getTime() - 25 * HOUR) },
      { keyHash: 'k_old_3', attempts: 1, windowStartedAt: daysAgo(30) },
      // Within the last day: kept (the limiter itself only needs 15 minutes).
      { keyHash: 'k_recent', attempts: 2, windowStartedAt: new Date(NOW.getTime() - 23 * HOUR) },
      { keyHash: 'k_live', attempts: 4, windowStartedAt: new Date(NOW.getTime() - 60_000) },
    ]);
    const result = await runRetention(app.db, { now: NOW, batchSize: 2 });
    expect(result.signInAttempts).toBe(3);
    expect(result.failed.global).toBe(0);
    expect(
      (await raw.db.select({ k: signInAttempts.keyHash }).from(signInAttempts))
        .map((r) => r.k)
        .sort(),
    ).toEqual(['k_live', 'k_recent']);
  });

  it('deletes usage written for a deleted workspace after its purge (an in-flight run)', async () => {
    // org_recent was deleted 10 days ago; org_a is listed but still a workspace (kept).
    await raw.db.insert(agentUsage).values([
      { orgId: 'org_recent', userId: 'u1', provider: 'openai', model: 'late' },
      { orgId: 'org_a', userId: 'u1', provider: 'openai', model: 'live' },
    ]);
    const result = await runRetention(app.db, { now: NOW });
    expect(result.deletedUsage).toBe(1);
    const left = await raw.db
      .select({ model: agentUsage.model })
      .from(agentUsage)
      .where(inArray(agentUsage.model, ['late', 'live']));
    expect(left.map((r) => r.model)).toEqual(['live']);
  });
});
