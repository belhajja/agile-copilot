import { randomUUID } from 'node:crypto';
import { createJiraConnection } from '@agile/connections';
import {
  jiraBoardIssues,
  jiraBoards,
  jiraIssues,
  jiraIssueTransitions,
  jiraSprintIssues,
  jiraSprints,
  jiraSyncRuns,
  jiraSyncStates,
} from '@agile/db';
import type { AtlassianOAuthClient } from '@agile/jira';
import { startMockJira } from '@agile/jira/testing';
import { and, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverBoards, listBoards, setBoardSelection } from './boards';
import { runSync } from './run-sync';
import { NOW, owner, startSyncHarness } from './test-harness';

describe('runSync', () => {
  let h: Awaited<ReturnType<typeof startSyncHarness>>;
  let connectionId = '';
  const job = () => ({ orgId: 'org_a', connectionId, trigger: 'manual' as const });
  const boardIssueCount = async (name: string) => {
    const [row] = await h.rawDb
      .select({ n: count() })
      .from(jiraBoardIssues)
      .innerJoin(jiraBoards, eq(jiraBoards.id, jiraBoardIssues.boardId))
      .where(eq(jiraBoards.name, name));
    return row?.n ?? 0;
  };

  beforeAll(async () => {
    h = await startSyncHarness();
    connectionId = await h.connect();
    await discoverBoards(h.deps, owner(), connectionId);
  });
  afterAll(async () => h?.stop());

  it('refuses to sync a connection without selected boards', async () => {
    expect(await runSync(h.deps, job())).toEqual({ ok: false, code: 'no_boards' });
  });

  it('first sync reads both boards completely', async () => {
    const boards = await listBoards(h.deps, 'org_a', connectionId);
    await setBoardSelection(
      h.deps,
      owner(),
      connectionId,
      boards.map((b) => b.id),
    );
    expect(await runSync(h.deps, job())).toEqual({ ok: true, mode: 'full', boards: 2, issues: 56 });
    expect(await boardIssueCount('DEMO Scrum')).toBe(25);
    expect(await boardIssueCount('OPS Kanban')).toBe(31);

    const sprints = await h.rawDb.select().from(jiraSprints).orderBy(jiraSprints.jiraSprintId);
    expect(sprints.map((s) => [s.name, s.state])).toEqual([
      ['DEMO Sprint 1', 'closed'],
      ['DEMO Sprint 2', 'closed'],
      ['DEMO Sprint 3', 'closed'],
      ['DEMO Sprint 4', 'active'],
    ]);
    // The story carried out of sprint 1 belongs to sprints 1 and 2.
    const [carried] = await h.rawDb.select().from(jiraIssues).where(eq(jiraIssues.key, 'DEMO-6'));
    const membership = await h.rawDb
      .select({ sprint: jiraSprintIssues.jiraSprintId, removedAt: jiraSprintIssues.removedAt })
      .from(jiraSprintIssues)
      .where(eq(jiraSprintIssues.issueId, carried?.id ?? ''));
    expect(membership.sort((a, b) => a.sprint - b.sprint)).toEqual([
      { sprint: 1, removedAt: null },
      { sprint: 2, removedAt: null },
    ]);
    const transitions = await h.rawDb
      .select()
      .from(jiraIssueTransitions)
      .where(eq(jiraIssueTransitions.issueId, carried?.id ?? ''));
    expect(transitions.map((t) => t.toStatusId)).toEqual(['3', '10001', '10003']);

    const [state] = await h.rawDb.select().from(jiraSyncStates);
    expect(state).toMatchObject({
      status: 'ok',
      watermark: NOW,
      lastFullSyncAt: NOW,
      lastError: null,
    });
    const runs = await h.rawDb.select().from(jiraSyncRuns);
    // The earlier attempt without selected boards was recorded as a failed run.
    expect(runs.map((r) => r.error).sort()).toEqual(['no_boards', null]);
    const run = runs.find((r) => r.status === 'ok');
    expect(run).toMatchObject({
      status: 'ok',
      mode: 'full',
      trigger: 'manual',
      boardsSynced: 2,
      issuesUpserted: 56,
    });
  });

  it('stores labels, components, versions, priority and the epic name', async () => {
    const [first] = await h.rawDb.select().from(jiraIssues).where(eq(jiraIssues.key, 'DEMO-1'));
    expect(first).toMatchObject({
      labels: ['feature'],
      components: ['Web'],
      fixVersions: ['1.0'],
      priority: 'Medium',
      epicKey: 'EPIC-1',
      epicName: 'Checkout revamp',
    });
    // The epics themselves are on no board.
    expect(await h.rawDb.select().from(jiraIssues).where(eq(jiraIssues.key, 'EPIC-1'))).toEqual([]);
  });

  it('next sync is incremental with a relative, overlapping JQL window', async () => {
    const later = new Date(NOW.getTime() + 30 * 60_000);
    h.mock.requests.length = 0;
    const r = await runSync({ ...h.deps, now: () => later }, job());
    expect(r).toMatchObject({ ok: true, mode: 'incremental' });
    const searches = h.mock.requests.filter((q) => q.path.endsWith('/rest/api/2/search'));
    expect(searches.length).toBeGreaterThan(0);
    for (const s of searches) {
      expect(new URLSearchParams(s.search).get('jql')).toMatch(
        /AND updated >= "-45m" ORDER BY created ASC$/,
      );
    }
    // Nothing was lost: membership is untouched by an incremental read.
    expect(await boardIssueCount('OPS Kanban')).toBe(31);
  });

  it('a full re-sync drops issues that left a board', async () => {
    const leaving = h.dataset.issues.find((i) => i.key === 'OPS-1');
    if (!leaving) throw new Error('fixture');
    leaving.filterIds = [];
    // Each board re-reads itself completely once a day.
    await h.rawDb
      .update(jiraBoards)
      .set({ lastFullSyncAt: new Date(NOW.getTime() - 25 * 3_600_000) });
    try {
      expect(await runSync(h.deps, job())).toMatchObject({ ok: true, mode: 'full' });
      expect(await boardIssueCount('OPS Kanban')).toBe(30);
    } finally {
      leaving.filterIds = [102];
    }
  });

  it('records Jira failures on the sync state without throwing', async () => {
    const otherOrg = 'org_bad';
    const deps = {
      ...h.deps,
      testJira: async () => ({
        ok: true as const,
        deployment: 'datacenter' as const,
        version: '10',
        account: { id: 'x', displayName: 'X' },
      }),
    };
    const bad = await createJiraConnection(deps, owner(otherOrg), {
      name: 'Bad token',
      credentials: { kind: 'datacenter_pat', baseUrl: h.mock.url, token: 'revoked-pat' },
    });
    if (!bad.ok) throw new Error('setup');
    await discoverBoards(h.deps, owner(otherOrg), bad.connection.id); // fails (401), no boards
    expect(
      await runSync(h.deps, {
        orgId: otherOrg,
        connectionId: bad.connection.id,
        trigger: 'schedule',
      }),
    ).toEqual({ ok: false, code: 'no_boards' });
    // Give it a board row so the sync reaches Jira.
    await h.rawDb.insert(jiraBoards).values({
      orgId: otherOrg,
      connectionId: bad.connection.id,
      jiraBoardId: 1,
      name: 'DEMO',
      type: 'scrum',
      selected: true,
    });
    expect(
      await runSync(h.deps, {
        orgId: otherOrg,
        connectionId: bad.connection.id,
        trigger: 'schedule',
      }),
    ).toEqual({ ok: false, code: 'unauthorized' });
    const [state] = await h.rawDb
      .select()
      .from(jiraSyncStates)
      .where(eq(jiraSyncStates.connectionId, bad.connection.id));
    expect(state).toMatchObject({ status: 'error', lastError: 'unauthorized' });
  });

  it('runs one sync per connection at a time', async () => {
    const results = await Promise.all([runSync(h.deps, job()), runSync(h.deps, job())]);
    expect(results.map((r) => (r.ok ? 'ok' : r.code)).sort()).toEqual(['already_running', 'ok']);
  });

  it('re-checks the URL policy before every sync', async () => {
    expect(await runSync({ ...h.deps, allowedPrivateHosts: [] }, job())).toEqual({
      ok: false,
      code: 'blocked_url',
    });
  });

  it('is invisible to other workspaces', async () => {
    expect(await runSync(h.deps, { ...job(), orgId: 'org_z' })).toEqual({
      ok: false,
      code: 'not_found',
    });
    const [row] = await h.rawDb
      .select({ n: count() })
      .from(jiraSyncRuns)
      .where(and(eq(jiraSyncRuns.orgId, 'org_z')));
    expect(row?.n).toBe(0);
  });

  it('refreshes an expiring OAuth token before syncing a Cloud site', async () => {
    const cloud = await startMockJira({
      flavor: 'cloud',
      validAuthorization: 'Bearer access-2',
      pathPrefix: '/ex/jira/cloud-9',
      dataset: h.dataset,
      now: () => NOW,
    });
    try {
      const oauth: AtlassianOAuthClient = {
        createAuthorizationURL: () => new URL('https://auth.atlassian.com/authorize'),
        validateAuthorizationCode: async () => {
          throw new Error('unused');
        },
        refreshAccessToken: async () => ({
          accessToken: () => 'access-2',
          refreshToken: () => 'refresh-2',
          accessTokenExpiresAt: () => new Date(NOW.getTime() + 3_600_000),
        }),
      };
      const deps = { ...h.deps, oauth, atlassianApiBase: new URL(cloud.url).origin };
      const created = await createJiraConnection(
        {
          ...deps,
          testJira: async () => ({
            ok: true as const,
            deployment: 'cloud' as const,
            version: '1',
            account: { id: 'a', displayName: 'A' },
          }),
        },
        owner('org_cloud'),
        {
          name: 'Acme Cloud',
          credentials: {
            kind: 'cloud_oauth',
            baseUrl: 'https://acme.atlassian.net',
            cloudId: 'cloud-9',
            accessToken: 'access-1',
          },
          oauth: {
            refreshToken: 'refresh-1',
            expiresAt: new Date(Date.now() - 1000).toISOString(),
          },
          oauthGrantId: randomUUID(),
        },
      );
      if (!created.ok) throw new Error('setup');
      const found = await discoverBoards(deps, owner('org_cloud'), created.connection.id);
      expect(found.ok).toBe(true);
      const boards = await listBoards(deps, 'org_cloud', created.connection.id);
      await setBoardSelection(
        deps,
        owner('org_cloud'),
        created.connection.id,
        boards.map((b) => b.id),
      );
      expect(
        await runSync(deps, {
          orgId: 'org_cloud',
          connectionId: created.connection.id,
          trigger: 'manual',
        }),
      ).toMatchObject({ ok: true, issues: 56 });
      expect(
        await runSync(
          { ...deps, oauth: undefined },
          { orgId: 'org_cloud', connectionId: created.connection.id, trigger: 'manual' },
        ),
      ).toEqual({ ok: false, code: 'oauth_unavailable' });
    } finally {
      await cloud.close();
    }
  });
});
