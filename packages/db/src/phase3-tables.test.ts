import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Tx, withOrg } from './client';
import { purgeOrgTenantRows } from './purge';
import { agentApprovals, agentConversations, agentMessages, agentUsage } from './schema';
import { startTestDatabase, type TestDatabase } from './testing';

const PHASE3_TABLES = ['agent_approvals', 'agent_conversations', 'agent_messages', 'agent_usage'];

/** One row in every Phase 3 table. */
async function seed(tx: Tx, orgId: string) {
  const [conversation] = await tx
    .insert(agentConversations)
    .values({ orgId, userId: 'user_1', title: 'Sprint health' })
    .returning();
  if (!conversation) throw new Error('seed failed');
  await tx.insert(agentMessages).values({
    orgId,
    conversationId: conversation.id,
    id: 'm1',
    seq: 0,
    role: 'user',
    parts: [{ type: 'text', text: 'hi' }],
  });
  await tx.insert(agentApprovals).values({
    orgId,
    userId: 'user_1',
    conversationId: conversation.id,
    approvalId: 'ap1',
    toolCallId: 'tc1',
    toolName: 'jira_add_comment',
    input: { issueKey: 'DEMO-1', body: 'hi' },
    inputHash: 'h',
  });
  await tx.insert(agentUsage).values({
    orgId,
    userId: 'user_1',
    conversationId: conversation.id,
    provider: 'openai',
    model: 'm',
    inputTokens: 10,
    outputTokens: 5,
  });
  return conversation.id;
}

describe('Phase 3 tenant tables (as app_user)', () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createDb>;
  let owner: ReturnType<typeof createDb>;
  let conversationA = '';

  const countAll = async (orgId: string) => {
    const counts: Record<string, number> = {};
    for (const table of PHASE3_TABLES) {
      const [row] = (await owner.db.execute(
        sql`select count(*)::int as n from ${sql.identifier(table)} where org_id = ${orgId}`,
      )) as unknown as { n: number }[];
      counts[table] = row?.n ?? -1;
    }
    return counts;
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = createDb(tdb.appUrl, { max: 1 });
    owner = createDb(tdb.ownerUrl, { max: 1 });
    conversationA = await withOrg(app.db, 'org_a', (tx) => seed(tx, 'org_a'));
    await withOrg(app.db, 'org_b', (tx) => seed(tx, 'org_b'));
  });
  afterAll(async () => {
    await app?.close();
    await owner?.close();
    await tdb?.stop();
  });

  it('isolates every Phase 3 table by org', async () => {
    for (const table of PHASE3_TABLES) {
      const rows = (await withOrg(app.db, 'org_a', (tx) =>
        tx.execute(sql`select org_id from ${sql.identifier(table)}`),
      )) as unknown as { org_id: string }[];
      expect({ table, orgs: [...new Set(rows.map((r) => r.org_id))] }).toEqual({
        table,
        orgs: ['org_a'],
      });
    }
  });

  const pgError = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      const e = ((error as { cause?: unknown }).cause ?? error) as {
        code?: string;
        constraint_name?: string;
      };
      return { code: e.code, constraint: e.constraint_name };
    }
    return 'no error';
  };
  const approval = (conversationId: string, approvalId: string, toolCallId: string) => ({
    orgId: 'org_a',
    userId: 'user_1',
    conversationId,
    approvalId,
    toolCallId,
    toolName: 'jira_add_comment',
    input: {},
    inputHash: 'h2',
  });

  it('binds one approval per tool call in a conversation', async () => {
    const result = await pgError(
      withOrg(app.db, 'org_a', (tx) =>
        tx.insert(agentApprovals).values(approval(conversationA, 'ap2', 'tc1')),
      ),
    );
    expect(result).toEqual({ code: '23505', constraint: 'agent_approvals_conversation_call_uq' });
  });

  it('binds one approval per approval id in a conversation', async () => {
    const result = await pgError(
      withOrg(app.db, 'org_a', (tx) =>
        tx.insert(agentApprovals).values(approval(conversationA, 'ap1', 'tc9')),
      ),
    );
    expect(result).toEqual({
      code: '23505',
      constraint: 'agent_approvals_conversation_approval_uq',
    });
  });

  it('keeps one seq per message in a conversation', async () => {
    const result = await pgError(
      withOrg(app.db, 'org_a', (tx) =>
        tx.insert(agentMessages).values({
          orgId: 'org_a',
          conversationId: conversationA,
          id: 'm2',
          seq: 0,
          role: 'assistant',
          parts: [],
        }),
      ),
    );
    expect(result).toEqual({ code: '23505', constraint: 'agent_messages_conversation_seq_uq' });
  });

  it('allows the same tool call id in another conversation', async () => {
    await withOrg(app.db, 'org_a', async (tx) => {
      const [other] = await tx
        .insert(agentConversations)
        .values({ orgId: 'org_a', userId: 'user_1' })
        .returning();
      if (!other) throw new Error('insert failed');
      await tx.insert(agentApprovals).values(approval(other.id, 'ap1', 'tc1'));
      await tx.delete(agentConversations).where(eq(agentConversations.id, other.id));
    });
  });

  it('refuses cross-org writes on every Phase 3 table', async () => {
    const before = await countAll('org_a');
    const snapshot = async () =>
      (await owner.db.execute(
        sql`select (select count(*)::int from agent_conversations where org_id = 'org_a' and title = 'Sprint health') as c,
                   (select count(*)::int from agent_messages where org_id = 'org_a' and seq = 0) as m,
                   (select count(*)::int from agent_approvals where org_id = 'org_a' and tool_name = 'jira_add_comment') as a,
                   (select count(*)::int from agent_usage where org_id = 'org_a' and model = 'm') as u`,
      )) as unknown as Record<string, number>[];
    const snapBefore = await snapshot();

    const inserts: Record<string, () => Promise<unknown>> = {
      agent_conversations: () =>
        withOrg(app.db, 'org_b', (tx) =>
          tx.insert(agentConversations).values({ orgId: 'org_a', userId: 'u' }),
        ),
      agent_messages: () =>
        withOrg(app.db, 'org_b', (tx) =>
          tx.insert(agentMessages).values({
            orgId: 'org_a',
            conversationId: conversationA,
            id: 'x',
            seq: 99,
            role: 'user',
            parts: [],
          }),
        ),
      agent_approvals: () =>
        withOrg(app.db, 'org_b', (tx) =>
          tx.insert(agentApprovals).values(approval(conversationA, 'apx', 'tcx')),
        ),
      agent_usage: () =>
        withOrg(app.db, 'org_b', (tx) =>
          tx.insert(agentUsage).values({
            orgId: 'org_a',
            userId: 'u',
            provider: 'p',
            model: 'x',
          }),
        ),
    };
    for (const [table, run] of Object.entries(inserts)) {
      expect({ table, ...((await pgError(run())) as object) }).toMatchObject({
        table,
        code: '42501',
      });
    }

    for (const table of PHASE3_TABLES) {
      const [updated, deleted] = await withOrg(app.db, 'org_b', async (tx) => [
        (await tx.execute(
          sql`update ${sql.identifier(table)} set org_id = 'org_b' where org_id = 'org_a' returning 1`,
        )) as unknown as unknown[],
        (await tx.execute(
          sql`delete from ${sql.identifier(table)} where org_id = 'org_a' returning 1`,
        )) as unknown as unknown[],
      ]);
      expect({ table, updated: updated?.length, deleted: deleted?.length }).toEqual({
        table,
        updated: 0,
        deleted: 0,
      });
    }
    expect(await countAll('org_a')).toEqual(before);
    expect(await snapshot()).toEqual(snapBefore);
  });

  it('deleting a conversation removes its messages and approvals but keeps usage', async () => {
    await withOrg(app.db, 'org_a', (tx) =>
      tx.delete(agentConversations).where(eq(agentConversations.id, conversationA)),
    );
    expect(await countAll('org_a')).toEqual({
      agent_approvals: 0,
      agent_conversations: 0,
      agent_messages: 0,
      agent_usage: 1,
    });
  });

  it('purging an org empties every Phase 3 table for it and only it', async () => {
    await withOrg(app.db, 'org_a', (tx) => seed(tx, 'org_a'));
    expect(await countAll('org_a')).toEqual({
      agent_approvals: 1,
      agent_conversations: 1,
      agent_messages: 1,
      agent_usage: 2,
    });
    await withOrg(app.db, 'org_a', (tx) => purgeOrgTenantRows(tx, 'org_a'));
    expect(Object.values(await countAll('org_a')).every((n) => n === 0)).toBe(true);
    expect(Object.values(await countAll('org_b')).every((n) => n === 1)).toBe(true);
  });
});
