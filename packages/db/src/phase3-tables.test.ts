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

  it('binds one approval per tool call in a conversation', async () => {
    await expect(
      withOrg(app.db, 'org_a', (tx) =>
        tx.insert(agentApprovals).values({
          orgId: 'org_a',
          userId: 'user_1',
          conversationId: conversationA,
          approvalId: 'ap2',
          toolCallId: 'tc1',
          toolName: 'jira_add_comment',
          input: {},
          inputHash: 'h2',
        }),
      ),
    ).rejects.toThrow();
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
    await withOrg(app.db, 'org_a', (tx) => purgeOrgTenantRows(tx, 'org_a'));
    expect(Object.values(await countAll('org_a')).every((n) => n === 0)).toBe(true);
    expect(Object.values(await countAll('org_b')).every((n) => n === 1)).toBe(true);
  });
});
