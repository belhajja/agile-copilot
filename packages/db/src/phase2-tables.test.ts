import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Tx, withOrg } from './client';
import { purgeOrgTenantRows } from './purge';
import {
  dashboards,
  jiraBoardIssues,
  jiraBoardSprints,
  jiraBoards,
  jiraConnections,
  jiraIssueChanges,
  jiraIssues,
  jiraIssueTransitions,
  jiraSprintIssues,
  jiraSprints,
  jiraStatusMappings,
  jiraSyncRuns,
  jiraSyncStates,
} from './schema';
import { startTestDatabase, type TestDatabase } from './testing';

const PHASE2_TABLES = [
  'dashboards',
  'jira_board_issues',
  'jira_board_sprints',
  'jira_boards',
  'jira_issue_changes',
  'jira_issue_transitions',
  'jira_issues',
  'jira_sprint_issues',
  'jira_sprints',
  'jira_status_mappings',
  'jira_sync_runs',
  'jira_sync_states',
];

/** One row in every Phase 2 table, all hanging off one new connection. */
async function seed(tx: Tx, orgId: string) {
  const connectionId = randomUUID();
  await tx.insert(jiraConnections).values({
    id: connectionId,
    orgId,
    name: 'Jira',
    deployment: 'datacenter',
    authType: 'pat',
    baseUrl: `https://jira.example/${connectionId}`,
    secret: 's1.x.y.z',
    createdBy: 'user_1',
  });
  const [board] = await tx
    .insert(jiraBoards)
    .values({ orgId, connectionId, jiraBoardId: 1, name: 'Board', type: 'scrum' })
    .returning();
  const [issue] = await tx
    .insert(jiraIssues)
    .values({
      orgId,
      connectionId,
      jiraIssueId: '10001',
      key: 'A-1',
      summary: 'Issue',
      issueType: 'Story',
      statusId: '1',
      jiraCreatedAt: new Date(),
      jiraUpdatedAt: new Date(),
    })
    .returning();
  const [sprint] = await tx
    .insert(jiraSprints)
    .values({ orgId, connectionId, jiraSprintId: 7, name: 'Sprint 7', state: 'active' })
    .returning();
  if (!board || !issue || !sprint) throw new Error('seed failed');
  await tx.insert(jiraStatusMappings).values({
    orgId,
    boardId: board.id,
    jiraStatusId: '1',
    statusName: 'To Do',
    jiraCategory: 'new',
    category: 'todo',
  });
  await tx.insert(jiraSyncStates).values({ orgId, connectionId });
  await tx.insert(jiraSyncRuns).values({ orgId, connectionId, trigger: 'manual', mode: 'full' });
  await tx.insert(jiraBoardIssues).values({ orgId, boardId: board.id, issueId: issue.id });
  await tx.insert(jiraIssueTransitions).values({
    orgId,
    issueId: issue.id,
    seq: 0,
    at: new Date(),
    fromStatusId: '1',
    toStatusId: '2',
  });
  await tx
    .insert(jiraIssueChanges)
    .values({ orgId, issueId: issue.id, seq: 1, at: new Date(), kind: 'estimate', toValue: '3' });
  await tx.insert(jiraBoardSprints).values({ orgId, boardId: board.id, sprintId: sprint.id });
  await tx
    .insert(jiraSprintIssues)
    .values({ orgId, connectionId, issueId: issue.id, jiraSprintId: 7, addedAt: new Date() });
  await tx
    .insert(dashboards)
    .values({ orgId, userId: 'user_1', boardId: board.id, name: 'Scrum', kind: 'scrum' });
}

describe('Phase 2 tenant tables (as app_user)', () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createDb>;
  let owner: ReturnType<typeof createDb>;

  const countAll = async (orgId: string) => {
    const counts: Record<string, number> = {};
    for (const table of PHASE2_TABLES) {
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
    await withOrg(app.db, 'org_a', (tx) => seed(tx, 'org_a'));
    await withOrg(app.db, 'org_b', (tx) => seed(tx, 'org_b'));
  });
  afterAll(async () => {
    await app?.close();
    await owner?.close();
    await tdb?.stop();
  });

  it('isolates every Phase 2 table by org', async () => {
    for (const table of PHASE2_TABLES) {
      const rows = (await withOrg(app.db, 'org_a', (tx) =>
        tx.execute(sql`select org_id from ${sql.identifier(table)}`),
      )) as unknown as { org_id: string }[];
      expect({ table, orgs: [...new Set(rows.map((r) => r.org_id))] }).toEqual({
        table,
        orgs: ['org_a'],
      });
    }
  });

  it('allows only one default dashboard of a kind per user and board', async () => {
    const [board] = await withOrg(app.db, 'org_a', (tx) => tx.select().from(jiraBoards));
    await expect(
      withOrg(app.db, 'org_a', (tx) =>
        tx.insert(dashboards).values({
          orgId: 'org_a',
          userId: 'user_1',
          boardId: board?.id ?? '',
          name: 'Scrum again',
          kind: 'scrum',
        }),
      ),
    ).rejects.toThrow();
  });

  it('purging an org empties every Phase 2 table for it and only it', async () => {
    await withOrg(app.db, 'org_a', (tx) => purgeOrgTenantRows(tx, 'org_a'));
    expect(Object.values(await countAll('org_a')).every((n) => n === 0)).toBe(true);
    expect(Object.values(await countAll('org_b')).every((n) => n === 1)).toBe(true);
  });

  it('lets the app role own the pg-boss schema', async () => {
    const [row] = (await owner.db.execute(sql`
      select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = 'pgboss'
    `)) as unknown as { owner: string }[];
    expect(row?.owner).toBe('app_user');
  });
});
