import {
  account,
  agentApprovals,
  agentConversations,
  agentMessages,
  agentUsage,
  auditLog,
  createDb,
  invitation,
  jiraConnections,
  mcpRateBuckets,
  mcpTokens,
  member,
  organization,
  personalDataExports,
  session,
  skillBuilderCalls,
  skillRuns,
  skills,
  skillVersions,
  user,
} from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DELETION_ATTEMPTS_PER_HOUR,
  deleteAccount,
  EXPORT_PAGE_SIZE,
  EXPORTS_PER_HOUR,
  exportUserData,
  openUserExport,
} from './gdpr';

const NOW = new Date('2026-10-04T12:00:00Z');

describe('personal data: export and account deletion', () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createDb>;
  let raw: ReturnType<typeof createDb>;

  /** One conversation (one message, one approval), one usage row and one audit row. */
  const seedPerson = async (orgId: string, userId: string, text: string) => {
    const [c] = await raw.db
      .insert(agentConversations)
      .values({ orgId, userId, title: `${userId} chat` })
      .returning();
    const conversationId = c?.id ?? '';
    await raw.db.insert(agentMessages).values({
      orgId,
      conversationId,
      id: `m-${userId}`,
      seq: 0,
      role: 'user',
      parts: [{ type: 'text', text }],
    });
    await raw.db.insert(agentApprovals).values({
      orgId,
      userId,
      conversationId,
      approvalId: `a-${userId}`,
      toolCallId: 't1',
      toolName: 'jira_add_comment',
      input: { issueKey: 'DEMO-1', body: text },
      inputHash: 'h',
    });
    await raw.db
      .insert(agentUsage)
      .values({ orgId, userId, provider: 'openai', model: 'm', inputTokens: 5 });
    await raw.db
      .insert(auditLog)
      .values({ orgId, actorUserId: userId, action: 'agent_action.proposed' });
    const [skill] = await raw.db
      .insert(skills)
      .values({
        orgId,
        ownerUserId: userId,
        name: `${userId}-digest`,
        description: 'Weekly digest',
        trigger: 'schedule',
        output: 'email',
      })
      .returning();
    await raw.db.insert(skillVersions).values({
      orgId,
      skillId: skill?.id ?? '',
      version: 1,
      document: `---\nname: ${userId}-digest\n---\n${text}`,
      createdBy: userId,
    });
    await raw.db.insert(skillRuns).values({
      orgId,
      skillId: skill?.id ?? '',
      ownerUserId: userId,
      version: 1,
      trigger: 'manual',
      status: 'succeeded',
      output: `Report for ${userId}`,
    });
  };

  interface Exported {
    user: { email: string };
    signInMethods: Record<string, unknown>[];
    sessions: Record<string, unknown>[];
    invitations: { sent: Record<string, unknown>[]; received: Record<string, unknown>[] };
    workspaces: {
      workspace: { orgId: string; workspace: string; role: string[]; member: boolean };
      conversations: { title: string; messages: { parts: { text: string }[] }[] }[];
      skills: { name: string; document: string; runs: { output: string }[] }[];
      usage: unknown[];
      actionsInAuditLog: { action: string }[];
      jiraConnections: Record<string, unknown>[];
      other: Record<string, Record<string, unknown>[]>;
    }[];
  }

  const exportOf = async (userId: string) => {
    let text = '';
    for await (const chunk of exportUserData(app.db, userId)) text += chunk;
    return JSON.parse(text) as Exported;
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = createDb(tdb.appUrl, { max: 2 });
    raw = createDb(tdb.ownerUrl, { max: 1 });
    await raw.db.insert(user).values([
      { id: 'u_ann', name: 'Ann', email: 'ann@example.com' },
      { id: 'u_bob', name: 'Bob', email: 'bob@example.com' },
    ]);
    await raw.db.insert(organization).values([
      { id: 'org_1', name: 'One', slug: 'one', createdAt: NOW },
      { id: 'org_2', name: 'Two', slug: 'two', createdAt: NOW },
    ]);
    await raw.db.insert(member).values([
      { id: 'm1', organizationId: 'org_1', userId: 'u_ann', role: 'owner', createdAt: NOW },
      { id: 'm2', organizationId: 'org_1', userId: 'u_bob', role: 'admin', createdAt: NOW },
      { id: 'm3', organizationId: 'org_2', userId: 'u_ann', role: 'viewer', createdAt: NOW },
    ]);
    await raw.db.insert(session).values({
      id: 's1',
      userId: 'u_ann',
      token: 'tok-secret-session',
      ipAddress: '203.0.113.7',
      userAgent: 'Firefox',
      expiresAt: new Date(Date.now() + 86_400_000),
      updatedAt: NOW,
    });
    await raw.db.insert(account).values({
      id: 'acc1',
      accountId: 'kc-sub-ann',
      providerId: 'keycloak',
      userId: 'u_ann',
      accessToken: 'enc-access-token',
      refreshToken: 'enc-refresh-token',
      idToken: 'plain.id.token',
      password: 'hash-of-password',
      updatedAt: NOW,
    });
    await raw.db.insert(invitation).values([
      {
        id: 'inv_sent',
        organizationId: 'org_1',
        email: 'carol@example.com',
        role: 'viewer',
        expiresAt: new Date(Date.now() + 86_400_000),
        inviterId: 'u_ann',
      },
      {
        id: 'inv_received',
        organizationId: 'org_1',
        email: 'ann@example.com',
        role: 'manager',
        expiresAt: new Date(Date.now() + 86_400_000),
        inviterId: 'u_bob',
      },
    ]);
    // The Jira account a connection signed in as is the connecting person's (P5 final wave).
    const connection = (id: string, createdBy: string, accountName: string) => ({
      id,
      orgId: 'org_1',
      name: `${accountName} site`,
      deployment: 'cloud' as const,
      authType: 'basic' as const,
      baseUrl: `https://${createdBy}.atlassian.net`,
      accountId: `jira-${createdBy}`,
      accountName,
      secret: 'enc-jira-secret',
      createdBy,
    });
    await raw.db
      .insert(jiraConnections)
      .values([
        connection('00000000-0000-4000-8000-0000000000a1', 'u_ann', 'Ann Jira Name'),
        connection('00000000-0000-4000-8000-0000000000b1', 'u_bob', 'Bob Jira Name'),
      ]);
    await seedPerson('org_1', 'u_ann', 'Ann asks about velocity');
    await seedPerson('org_2', 'u_ann', 'Ann in the second workspace');
    await seedPerson('org_1', 'u_bob', 'Bob private question');
  });
  afterAll(async () => {
    await app?.close();
    await raw?.close();
    await tdb?.stop();
  });

  it('exports everything about one person, from every workspace, and nothing about others', async () => {
    const data = await exportOf('u_ann');
    expect(data.user.email).toBe('ann@example.com');
    expect(data.workspaces.map((w) => [w.workspace.workspace, w.workspace.role])).toEqual([
      ['One', ['owner']],
      ['Two', ['viewer']],
    ]);
    const [one] = data.workspaces;
    expect(one?.conversations.map((c) => c.messages[0]?.parts[0]?.text)).toEqual([
      'Ann asks about velocity',
    ]);
    expect(one?.usage).toHaveLength(1);
    expect(one?.skills).toEqual([
      expect.objectContaining({
        name: 'u_ann-digest',
        document: expect.stringContaining('Ann asks about velocity'),
        runs: [expect.objectContaining({ output: 'Report for u_ann' })],
      }),
    ]);
    expect(one?.actionsInAuditLog.map((a) => a.action)).toEqual(['agent_action.proposed']);
    // Later tables with a personal column come through the generic section.
    expect(one?.other.agent_approvals?.map((a) => a.approval_id)).toEqual(['a-u_ann']);
    // The Jira connections they made, with the Jira account they signed in as (never the secret).
    expect(one?.jiraConnections).toEqual([
      expect.objectContaining({
        name: 'Ann Jira Name site',
        accountId: 'jira-u_ann',
        accountName: 'Ann Jira Name',
      }),
    ]);
    expect(data.workspaces[1]?.jiraConnections).toEqual([]);
    expect(JSON.stringify(data)).not.toContain('Bob private question');
    expect(JSON.stringify(data)).not.toContain('Bob Jira Name');
    expect(JSON.stringify(data)).not.toContain('enc-jira-secret');
  });

  it('includes sign-in methods, sessions and invitations, never a token, hash or password', async () => {
    const data = await exportOf('u_ann');
    expect(data.signInMethods).toEqual([
      expect.objectContaining({ providerId: 'keycloak', accountId: 'kc-sub-ann' }),
    ]);
    expect(data.sessions).toEqual([
      expect.objectContaining({ ipAddress: '203.0.113.7', userAgent: 'Firefox' }),
    ]);
    expect(data.invitations.sent).toEqual([
      expect.objectContaining({ workspace: 'One', role: 'viewer', status: 'pending' }),
    ]);
    expect(data.invitations.received).toEqual([
      expect.objectContaining({ workspace: 'One', role: 'manager', email: 'ann@example.com' }),
    ]);
    const text = JSON.stringify(data);
    for (const secret of [
      'tok-secret-session',
      'enc-access-token',
      'enc-refresh-token',
      'plain.id.token',
      'hash-of-password',
      // The invitee of an invitation Ann sent is someone else's data.
      'carol@example.com',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('pages long sections instead of loading them at once', async () => {
    const orgId = 'org_1';
    const [c] = await raw.db
      .insert(agentConversations)
      .values({ orgId, userId: 'u_bob', title: 'long' })
      .returning();
    const count = EXPORT_PAGE_SIZE * 2 + 3;
    await raw.db.insert(agentMessages).values(
      Array.from({ length: count }, (_, seq) => ({
        orgId,
        conversationId: c?.id ?? '',
        id: `long-${seq}`,
        seq,
        role: 'user' as const,
        parts: [{ type: 'text', text: `line ${seq}` }],
      })),
    );
    await raw.db.insert(agentUsage).values(
      Array.from({ length: count }, () => ({
        orgId,
        userId: 'u_bob',
        provider: 'openai',
        model: 'm',
      })),
    );
    const data = await exportOf('u_bob');
    const long = data.workspaces[0]?.conversations.find((x) => x.title === 'long');
    expect(long?.messages.map((m) => m.parts[0]?.text)).toEqual(
      Array.from({ length: count }, (_, seq) => `line ${seq}`),
    );
    expect(data.workspaces[0]?.usage).toHaveLength(count + 1);
    await raw.db.delete(agentConversations).where(eq(agentConversations.id, c?.id ?? ''));
    await raw.db.delete(agentUsage).where(eq(agentUsage.userId, 'u_bob'));
    await raw.db
      .insert(agentUsage)
      .values({ orgId, userId: 'u_bob', provider: 'openai', model: 'm', inputTokens: 5 });
  });

  it('refuses to delete the only owner of a workspace', async () => {
    await raw.db.update(member).set({ role: 'admin' }).where(eq(member.id, 'm2'));
    expect(await deleteAccount(app.db, 'u_ann')).toEqual({
      ok: false,
      code: 'sole_owner',
      workspaces: ['One'],
    });
    expect(await raw.db.$count(agentConversations, eq(agentConversations.userId, 'u_ann'))).toBe(2);
  });

  it('erases the person, keeps pseudonymous usage and audit, and leaves colleagues alone', async () => {
    await raw.db.update(member).set({ role: 'owner' }).where(eq(member.id, 'm2'));
    expect(await deleteAccount(app.db, 'u_ann')).toEqual({ ok: true, workspaces: 2 });

    expect(await raw.db.$count(user, eq(user.id, 'u_ann'))).toBe(0);
    expect(await raw.db.$count(session, eq(session.userId, 'u_ann'))).toBe(0);
    expect(await raw.db.$count(account, eq(account.userId, 'u_ann'))).toBe(0);
    expect(await raw.db.$count(member, eq(member.userId, 'u_ann'))).toBe(0);
    // Invitations they sent and invitations addressed to them.
    expect(
      await raw.db.$count(invitation, inArray(invitation.id, ['inv_sent', 'inv_received'])),
    ).toBe(0);
    expect(await raw.db.$count(agentConversations, eq(agentConversations.userId, 'u_ann'))).toBe(0);
    expect(await raw.db.$count(agentMessages, eq(agentMessages.id, 'm-u_ann'))).toBe(0);
    expect(await raw.db.$count(agentApprovals, eq(agentApprovals.userId, 'u_ann'))).toBe(0);
    // Their skills go too, with versions; their runs (which outlive a deleted skill) as well.
    expect(await raw.db.$count(skills, eq(skills.ownerUserId, 'u_ann'))).toBe(0);
    expect(await raw.db.$count(skillRuns)).toBe(1);
    // Spend totals stay right; the id no longer leads to a person.
    expect(await raw.db.$count(agentUsage, eq(agentUsage.userId, 'u_ann'))).toBe(2);
    const audit = await raw.db.select().from(auditLog).where(eq(auditLog.actorUserId, 'u_ann'));
    expect(audit.map((a) => [a.orgId, a.action]).sort()).toEqual([
      ['org_1', 'agent_action.proposed'],
      ['org_1', 'user.deleted'],
      ['org_2', 'agent_action.proposed'],
      ['org_2', 'user.deleted'],
    ]);
    // The workspace keeps the connection Ann made, without her Jira identity.
    const conns = await raw.db
      .select({
        createdBy: jiraConnections.createdBy,
        accountId: jiraConnections.accountId,
        accountName: jiraConnections.accountName,
      })
      .from(jiraConnections)
      .orderBy(jiraConnections.createdBy);
    expect(conns).toEqual([
      { createdBy: 'u_ann', accountId: null, accountName: null },
      { createdBy: 'u_bob', accountId: 'jira-u_bob', accountName: 'Bob Jira Name' },
    ]);
    // Bob's data is untouched.
    expect(await raw.db.$count(agentConversations, eq(agentConversations.userId, 'u_bob'))).toBe(1);
    expect(await deleteAccount(app.db, 'u_ann')).toEqual({ ok: false, code: 'not_found' });
  });

  it('covers a workspace the person has left (M2)', async () => {
    await raw.db.insert(user).values({ id: 'u_dan', name: 'Dan', email: 'dan@example.com' });
    await raw.db
      .insert(organization)
      .values({ id: 'org_3', name: 'Three', slug: 'three', createdAt: NOW });
    // Dan is a member of org_1 only; he once used org_3 and left it.
    await raw.db.insert(member).values({
      id: 'm5',
      organizationId: 'org_1',
      userId: 'u_dan',
      role: 'viewer',
      createdAt: NOW,
    });
    await seedPerson('org_3', 'u_dan', 'Dan before leaving');

    const data = await exportOf('u_dan');
    expect(data.workspaces.map((w) => [w.workspace.workspace, w.workspace.member])).toEqual([
      ['One', true],
      ['Three', false],
    ]);
    expect(data.workspaces[1]?.conversations[0]?.messages[0]?.parts[0]?.text).toBe(
      'Dan before leaving',
    );

    // The indexed lookup behind it (P5-R37): workspace ids only, for this person only.
    const orgIdsOf = async (userId: string) =>
      (
        (await app.db.execute(sql`select id from user_org_ids(${userId}) as id`)) as unknown as {
          id: string;
        }[]
      ).map((r) => r.id);
    expect(await orgIdsOf('u_dan')).toEqual(['org_3']);
    expect(await orgIdsOf('u_stranger')).toEqual([]);

    expect(await deleteAccount(app.db, 'u_dan')).toEqual({ ok: true, workspaces: 2 });
    expect(await raw.db.$count(agentConversations, eq(agentConversations.userId, 'u_dan'))).toBe(0);
    expect(await raw.db.$count(skills, eq(skills.ownerUserId, 'u_dan'))).toBe(0);
    expect(await raw.db.$count(skillRuns, eq(skillRuns.ownerUserId, 'u_dan'))).toBe(0);
  });

  it('exports and deletes a person who belongs to no workspace (M3)', async () => {
    await raw.db.insert(user).values({ id: 'u_eve', name: 'Eve', email: 'eve@example.com' });
    const data = await exportOf('u_eve');
    expect(data.user.email).toBe('eve@example.com');
    expect(data.workspaces).toEqual([]);
    expect(await deleteAccount(app.db, 'u_eve')).toEqual({ ok: true, workspaces: 0 });
    expect(await raw.db.$count(user, eq(user.id, 'u_eve'))).toBe(0);
  });

  it('never leaves a workspace without an owner when its two owners leave at once (L12)', async () => {
    await raw.db.insert(user).values([
      { id: 'u_x', name: 'X', email: 'x@example.com' },
      { id: 'u_y', name: 'Y', email: 'y@example.com' },
    ]);
    await raw.db
      .insert(organization)
      .values({ id: 'org_4', name: 'Four', slug: 'four', createdAt: NOW });
    await raw.db.insert(member).values([
      { id: 'mx', organizationId: 'org_4', userId: 'u_x', role: 'owner', createdAt: NOW },
      { id: 'my', organizationId: 'org_4', userId: 'u_y', role: 'owner', createdAt: NOW },
    ]);
    const results = await Promise.all([deleteAccount(app.db, 'u_x'), deleteAccount(app.db, 'u_y')]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, code: 'sole_owner', workspaces: ['Four'] },
    ]);
    expect(await raw.db.$count(member, eq(member.organizationId, 'org_4'))).toBe(1);
  });

  it('drops secret columns from later tables, paging a table without a primary key', async () => {
    const n = EXPORT_PAGE_SIZE * 2 + 1;
    await raw.db.execute(sql`create table later_personal (
      org_id text not null, user_id text not null, n integer not null, secret text, note text)`);
    await raw.db.execute(sql`insert into later_personal
      select 'org_1', 'u_bob', g, 'shh-' || g, 'note ' || g from generate_series(1, ${n}) g`);
    try {
      const data = await exportOf('u_bob');
      const rows = data.workspaces[0]?.other.later_personal ?? [];
      expect(new Set(rows.map((r) => r.n)).size).toBe(n);
      expect(rows).toHaveLength(n);
      expect(rows[0]).toEqual(expect.objectContaining({ note: expect.any(String) }));
      expect(JSON.stringify(rows)).not.toContain('shh-');
    } finally {
      await raw.db.execute(sql`drop table later_personal`);
    }
  });

  it('erases builder reservations, MCP tokens and rate windows; pages them by primary key', async () => {
    await raw.db.insert(user).values({ id: 'u_gus', name: 'Gus', email: 'gus@example.com' });
    await raw.db.insert(member).values({
      id: 'm_gus',
      organizationId: 'org_1',
      userId: 'u_gus',
      role: 'viewer',
      createdAt: NOW,
    });
    const n = EXPORT_PAGE_SIZE + 5;
    await raw.db
      .insert(skillBuilderCalls)
      .values(Array.from({ length: n }, () => ({ orgId: 'org_1', userId: 'u_gus' })));
    await raw.db.insert(mcpTokens).values({
      orgId: 'org_1',
      userId: 'u_gus',
      name: 'cli',
      tokenHash: 'hash-of-token',
      prefix: 'ac_',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await raw.db.insert(mcpRateBuckets).values([
      { orgId: 'org_1', userId: 'u_gus', windowStart: NOW, count: 3 },
      { orgId: 'org_1', userId: 'u_gus', windowStart: new Date(NOW.getTime() + 60_000), count: 1 },
    ]);

    const other = (await exportOf('u_gus')).workspaces[0]?.other ?? {};
    expect(new Set(other.skill_builder_calls?.map((r) => r.id)).size).toBe(n);
    expect(other.mcp_tokens?.map((t) => t.name)).toEqual(['cli']);
    expect(other.mcp_rate_buckets).toHaveLength(2);
    expect(JSON.stringify(other)).not.toContain('hash-of-token');

    expect(await deleteAccount(app.db, 'u_gus')).toEqual({ ok: true, workspaces: 1 });
    expect(await raw.db.$count(skillBuilderCalls, eq(skillBuilderCalls.userId, 'u_gus'))).toBe(0);
    expect(await raw.db.$count(mcpTokens, eq(mcpTokens.userId, 'u_gus'))).toBe(0);
    expect(await raw.db.$count(mcpRateBuckets, eq(mcpRateBuckets.userId, 'u_gus'))).toBe(0);
  });

  it('runs one export per person at a time and a few per hour', async () => {
    await raw.db.insert(user).values({ id: 'u_fay', name: 'Fay', email: 'fay@example.com' });
    expect(await openUserExport(app.db, 'u_missing', NOW)).toEqual({
      ok: false,
      code: 'not_found',
    });

    // Two at once: one runs, the other is refused.
    const both = await Promise.all([
      openUserExport(app.db, 'u_fay', NOW),
      openUserExport(app.db, 'u_fay', NOW),
    ]);
    const running = both.find((r) => r.ok);
    expect(both.filter((r) => !r.ok)).toEqual([{ ok: false, code: 'export_in_progress' }]);
    let text = '';
    if (running?.ok) for await (const chunk of running.chunks) text += chunk;
    expect(JSON.parse(text).user.email).toBe('fay@example.com');

    // Finished (or abandoned: finish()) exports count against the hourly allowance.
    for (let i = 1; i < EXPORTS_PER_HOUR; i++) {
      const next = await openUserExport(app.db, 'u_fay', NOW);
      expect(next.ok).toBe(true);
      if (next.ok) await next.finish();
    }
    expect(await openUserExport(app.db, 'u_fay', NOW)).toEqual({
      ok: false,
      code: 'export_rate_limited',
    });
    const later = await openUserExport(app.db, 'u_fay', new Date(NOW.getTime() + 61 * 60_000));
    expect(later.ok).toBe(true);
    if (later.ok) await later.finish();
  });
  /** `db` counting the raw statements that call `user_org_ids` (the O(workspaces) lookup). */
  const countingOrgLookups = (db: typeof app.db) => {
    const seen = { lookups: 0 };
    const dialect = (db as unknown as { dialect: { sqlToQuery(q: unknown): { sql: string } } })
      .dialect;
    const proxied = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'execute') {
          return (query: Parameters<typeof db.execute>[0]) => {
            if (dialect.sqlToQuery(query).sql.includes('user_org_ids')) seen.lookups++;
            return target.execute(query);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    return { db: proxied, seen };
  };

  it('throttles deletion attempts before the workspace lookup; a sole owner never reaches it (P5-R44)', async () => {
    await raw.db.insert(user).values({ id: 'u_hal', name: 'Hal', email: 'hal@example.com' });
    await raw.db
      .insert(organization)
      .values({ id: 'org_hal', name: 'Hal Inc', slug: 'hal', createdAt: NOW });
    await raw.db.insert(member).values({
      id: 'm_hal',
      organizationId: 'org_hal',
      userId: 'u_hal',
      role: 'owner',
      createdAt: NOW,
    });
    const { db, seen } = countingOrgLookups(app.db);
    for (let i = 0; i < DELETION_ATTEMPTS_PER_HOUR; i++) {
      expect(await deleteAccount(db, 'u_hal', NOW)).toEqual({
        ok: false,
        code: 'sole_owner',
        workspaces: ['Hal Inc'],
      });
    }
    expect(await deleteAccount(db, 'u_hal', NOW)).toEqual({ ok: false, code: 'rate_limited' });
    expect(seen.lookups).toBe(0);
    // An hour later the allowance is back.
    expect(await deleteAccount(db, 'u_hal', new Date(NOW.getTime() + 61 * 60_000))).toEqual({
      ok: false,
      code: 'sole_owner',
      workspaces: ['Hal Inc'],
    });
  });

  it('refuses a person over the hourly allowance before the lookup, deleting nothing (P5-R44)', async () => {
    await raw.db.insert(user).values({ id: 'u_ivy', name: 'Ivy', email: 'ivy@example.com' });
    await raw.db.insert(personalDataExports).values(
      Array.from({ length: DELETION_ATTEMPTS_PER_HOUR }, () => ({
        userId: 'u_ivy',
        kind: 'deletion',
        startedAt: NOW,
        finishedAt: NOW,
      })),
    );
    const { db, seen } = countingOrgLookups(app.db);
    expect(await deleteAccount(db, 'u_ivy', NOW)).toEqual({ ok: false, code: 'rate_limited' });
    expect(seen.lookups).toBe(0);
    expect(await raw.db.$count(user, eq(user.id, 'u_ivy'))).toBe(1);
    // Exports are throttled on their own: deletion attempts do not use them up.
    const exp = await openUserExport(app.db, 'u_ivy', NOW);
    expect(exp.ok).toBe(true);
    if (exp.ok) await exp.finish();
    // A deletion that proceeds does use the lookup.
    expect(await deleteAccount(db, 'u_ivy', new Date(NOW.getTime() + 61 * 60_000))).toEqual({
      ok: true,
      workspaces: 0,
    });
    expect(seen.lookups).toBe(1);
  });
});
