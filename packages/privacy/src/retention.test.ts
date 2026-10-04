import {
  agentConversations,
  agentMessages,
  agentUsage,
  auditLog,
  createDb,
  deletedOrganizations,
  organization,
  skillBuilderCalls,
  skillRuns,
  skills,
  withOrg,
} from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyRetention, BUILDER_CALLS_RETENTION_DAYS, runRetention } from './retention';
import {
  DEFAULT_SETTINGS,
  getWorkspaceSettings,
  RETENTION_BOUNDS,
  SettingsError,
  updateWorkspaceSettings,
} from './settings';

const NOW = new Date('2026-10-04T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const admin = { orgId: 'org_a', userId: 'user_admin', roles: ['admin'] };

describe('retention and workspace settings', () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createDb>;
  let raw: ReturnType<typeof createDb>;

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
        id: `m${age}`,
        seq: 0,
        role: 'user',
        parts: [],
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
    const [skill] = await raw.db
      .insert(skills)
      .values({
        orgId,
        ownerUserId: 'u1',
        name: 'digest',
        description: 'd',
        trigger: 'schedule',
        output: 'email',
      })
      .returning();
    for (const age of [10, 200, 800]) {
      await raw.db.insert(skillRuns).values({
        orgId,
        skillId: skill?.id ?? '',
        ownerUserId: 'u1',
        version: 1,
        trigger: 'schedule',
        status: 'succeeded',
        output: `report ${age}`,
        createdAt: daysAgo(age),
      });
    }
    for (const status of ['queued', 'running'] as const) {
      await raw.db.insert(skillRuns).values({
        orgId,
        skillId: skill?.id ?? '',
        ownerUserId: 'u1',
        version: 1,
        trigger: 'manual',
        status,
        createdAt: daysAgo(800),
      });
    }
    // Skill-builder reservations (P4-R29): only the last hour counts toward the limit.
    for (const age of [0, 10]) {
      await raw.db
        .insert(skillBuilderCalls)
        .values({ orgId, userId: 'u1', createdAt: daysAgo(age) });
    }
  };
  const count = async (orgId: string) => {
    const [row] = (await raw.db.execute(sql`
      select (select count(*)::int from agent_conversations where org_id = ${orgId}) as conversations,
             (select count(*)::int from agent_messages where org_id = ${orgId}) as messages,
             (select count(*)::int from agent_usage where org_id = ${orgId}) as usage,
             (select count(*)::int from skill_runs where org_id = ${orgId}) as runs,
             (select count(*)::int from skill_builder_calls where org_id = ${orgId}) as builder,
             (select count(*)::int from audit_log where org_id = ${orgId} and action like 't%') as audit
    `)) as unknown as Record<string, number>[];
    return row;
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = createDb(tdb.appUrl, { max: 2 });
    raw = createDb(tdb.ownerUrl, { max: 1 });
    await raw.db.insert(organization).values([
      { id: 'org_a', name: 'A', slug: 'a', createdAt: NOW },
      { id: 'org_b', name: 'B', slug: 'b', createdAt: NOW },
    ]);
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
    ]) {
      await expect(updateWorkspaceSettings(app.db, admin, bad)).rejects.toBeInstanceOf(
        SettingsError,
      );
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
  });

  it('never goes below the windows the daily skill caps and the builder limit count', () => {
    // Skill-run caps count finished runs over 24 hours; the builder limit counts the last hour.
    for (const b of Object.values(RETENTION_BOUNDS)) expect(b.min).toBeGreaterThanOrEqual(1);
    expect(BUILDER_CALLS_RETENTION_DAYS).toBeGreaterThanOrEqual(1);
  });

  it("deletes what is older than the workspace's retention, and only in that workspace", async () => {
    const all = { conversations: 3, messages: 3, usage: 3, runs: 5, builder: 2, audit: 3 };
    expect(await count('org_a')).toEqual(all);
    // org_a: conversations and skill runs 30 days, usage 730, audit 365; builder calls 7 days.
    expect(await applyRetention(app.db, 'org_a', NOW)).toEqual({
      conversations: 2,
      skillRuns: 2,
      usage: 1,
      audit: 1,
      builderCalls: 1,
    });
    // The queued and running runs stay, whatever their age.
    expect(await count('org_a')).toEqual({
      conversations: 1,
      messages: 1,
      usage: 2,
      runs: 3,
      builder: 1,
      audit: 2,
    });
    expect(await count('org_b')).toEqual(all);
    // Idempotent: a second run the same day deletes nothing more.
    expect(await applyRetention(app.db, 'org_a', NOW)).toEqual({
      conversations: 0,
      skillRuns: 0,
      usage: 0,
      audit: 0,
      builderCalls: 0,
    });
  });

  it('never lets the app role delete audit entries younger than 90 days', async () => {
    // No direct DELETE for the app role (0001): only through purge_audit_log.
    await expect(
      withOrg(app.db, 'org_b', (tx) => tx.delete(auditLog).where(eq(auditLog.orgId, 'org_b'))),
    ).rejects.toThrow();
    const deleted = await withOrg(app.db, 'org_b', (tx) =>
      tx.execute<{ n: number }>(
        sql`select purge_audit_log('org_b', now() + interval '1 day') as n`,
      ),
    );
    // Only the 200- and 800-day-old entries go; the 10-day-old one stays.
    expect(deleted[0]?.n).toBe(2);
    const left = await raw.db.select().from(auditLog).where(eq(auditLog.orgId, 'org_b'));
    expect(left.map((r) => r.action)).toEqual(['t10']);
    // And it never touches another workspace than the one named.
    expect((await count('org_a'))?.audit).toBe(2);
    // The function restores the caller's tenant context.
    const ctx = await withOrg(app.db, 'org_a', async (tx) => {
      await tx.execute(sql`select purge_audit_log('org_b', now())`);
      return tx.execute<{ org: string }>(sql`select current_setting('app.current_org_id') as org`);
    });
    expect(ctx[0]?.org).toBe('org_a');
  });

  it('stops between workspaces when the worker shuts down', async () => {
    const stop = new AbortController();
    stop.abort();
    expect(await runRetention(app.db, { now: NOW, signal: stop.signal })).toEqual({
      workspaces: 0,
      failed: 0,
      deletedPurged: 0,
    });
  });

  it('purges a deleted workspace’s audit trail 90 days after the deletion', async () => {
    await raw.db.insert(auditLog).values([
      { orgId: 'org_gone', action: 'organization.deleted', createdAt: daysAgo(120) },
      { orgId: 'org_recent', action: 'organization.deleted', createdAt: daysAgo(120) },
    ]);
    await raw.db.insert(deletedOrganizations).values([
      { deletedOrgId: 'org_gone', deletedAt: daysAgo(100) },
      { deletedOrgId: 'org_recent', deletedAt: daysAgo(10) },
    ]);
    const result = await runRetention(app.db, { now: NOW });
    expect(result).toEqual({ workspaces: 2, failed: 0, deletedPurged: 1 });
    const remaining = await raw.db.select({ org: auditLog.orgId }).from(auditLog);
    expect(remaining.map((r) => r.org)).not.toContain('org_gone');
    expect(remaining.map((r) => r.org)).toContain('org_recent');
    expect((await raw.db.select().from(deletedOrganizations)).map((r) => r.deletedOrgId)).toEqual([
      'org_recent',
    ]);
  });
});
