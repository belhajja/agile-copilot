import { completeJiraOAuth, ForbiddenError } from '@agile/connections';
import { jiraBoards, jiraStatusMappings } from '@agile/db';
import type {
  AtlassianOAuthClient,
  AtlassianTokens,
  JiraCredentialsInput,
  JiraDataSource,
} from '@agile/jira';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  discoverBoards,
  listBoards,
  listStatusMappings,
  saveStatusMappings,
  setBoardSelection,
} from './boards';
import type { SyncDeps } from './deps';
import { runSync } from './run-sync';
import { manager, owner, startSyncHarness, viewer } from './test-harness';

describe('boards hardening', () => {
  let h: Awaited<ReturnType<typeof startSyncHarness>>;
  let connectionId = '';
  let boardIds: string[] = [];
  beforeAll(async () => {
    h = await startSyncHarness();
    connectionId = await h.connect();
    await discoverBoards(h.deps, owner(), connectionId);
    boardIds = (await listBoards(h.deps, 'org_a', connectionId)).map((b) => b.id);
    await setBoardSelection(h.deps, owner(), connectionId, boardIds);
  });
  afterAll(async () => h?.stop());

  const rawBoards = (orgId: string) =>
    h.rawDb.select().from(jiraBoards).where(eq(jiraBoards.orgId, orgId));
  const rawMappings = (orgId: string) =>
    h.rawDb.select().from(jiraStatusMappings).where(eq(jiraStatusMappings.orgId, orgId));

  it('keeps selection when boards are rediscovered', async () => {
    await discoverBoards(h.deps, owner(), connectionId);
    const boards = await listBoards(h.deps, 'org_a', connectionId);
    expect(boards).toHaveLength(2);
    expect(boards.every((b) => b.selected)).toBe(true);
  });

  it('prunes a board Jira no longer returns and leaves the others selected', async () => {
    const all = h.dataset.boards;
    h.dataset.boards = all.slice(0, 1);
    try {
      const r = await discoverBoards(h.deps, owner(), connectionId);
      expect(r.ok && r.boards.map((b) => [b.name, b.selected])).toEqual([['DEMO Scrum', true]]);
    } finally {
      h.dataset.boards = all;
    }
    await discoverBoards(h.deps, owner(), connectionId);
    const boards = await listBoards(h.deps, 'org_a', connectionId);
    expect(boards).toHaveLength(2);
    await setBoardSelection(
      h.deps,
      owner(),
      connectionId,
      boards.map((b) => b.id),
    );
    boardIds = boards.map((b) => b.id);
  });

  it('deletes nothing when Jira returns no boards at all', async () => {
    const beforeBoards = (await rawBoards('org_a')).length;
    const beforeMappings = (await rawMappings('org_a')).length;
    const all = h.dataset.boards;
    h.dataset.boards = [];
    try {
      expect(await discoverBoards(h.deps, owner(), connectionId)).toEqual({
        ok: false,
        code: 'no_boards',
      });
    } finally {
      h.dataset.boards = all;
    }
    const after = await rawBoards('org_a');
    expect(after).toHaveLength(beforeBoards);
    expect(after.every((b) => b.selected)).toBe(true);
    expect(await rawMappings('org_a')).toHaveLength(beforeMappings);
  });

  it('refuses cross-tenant mutations and leaves the owner tenant untouched', async () => {
    const before = await rawMappings('org_a');
    expect(
      await saveStatusMappings(h.deps, owner('org_b'), boardIds[0] ?? '', [
        { jiraStatusId: '10003', category: 'todo', blocked: false },
      ]),
    ).toEqual({ ok: false, code: 'not_found' });
    expect(await rawMappings('org_a')).toEqual(before);

    expect(await discoverBoards(h.deps, owner('org_b'), connectionId)).toEqual({
      ok: false,
      code: 'not_found',
    });
    expect(await rawBoards('org_b')).toEqual([]);

    const bConn = await h.connect(owner('org_b'), 'B Jira');
    expect(await setBoardSelection(h.deps, owner('org_b'), bConn, boardIds)).toEqual({
      ok: true,
      selected: 0,
    });
    expect((await rawBoards('org_a')).every((b) => b.selected)).toBe(true);
  });

  it('only lets owners and admins change selection and mappings', async () => {
    // Viewers and managers (who may use live Jira) cannot change what the workspace syncs.
    for (const actor of [viewer(), manager()]) {
      await expect(setBoardSelection(h.deps, actor, connectionId, [])).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(saveStatusMappings(h.deps, actor, boardIds[0] ?? '', [])).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
  });

  it('validates ids and categories before touching the database', async () => {
    expect(await discoverBoards(h.deps, owner(), 'not-a-uuid')).toEqual({
      ok: false,
      code: 'not_found',
    });
    expect(await setBoardSelection(h.deps, owner(), 'not-a-uuid', [])).toEqual({
      ok: false,
      code: 'not_found',
    });
    expect(
      await setBoardSelection(h.deps, owner(), connectionId, ['x', boardIds[0] ?? '']),
    ).toEqual({ ok: true, selected: 1 });
    await setBoardSelection(h.deps, owner(), connectionId, boardIds);
    expect(await listBoards(h.deps, 'org_a', 'nope')).toEqual([]);
    expect(await listStatusMappings(h.deps, 'org_a', 'nope')).toEqual([]);
    expect(
      await saveStatusMappings(h.deps, owner(), 'nope', [
        { jiraStatusId: '10003', category: 'done', blocked: false },
      ]),
    ).toEqual({ ok: false, code: 'not_found' });
    const before = await rawMappings('org_a');
    expect(
      await saveStatusMappings(h.deps, owner(), boardIds[0] ?? '', [
        { jiraStatusId: '10003', category: 'bogus' as never, blocked: false },
      ]),
    ).toEqual({ ok: false, code: 'invalid_input' });
    expect(await rawMappings('org_a')).toEqual(before);
  });

  it('counts a status once when an entry is repeated (last wins)', async () => {
    const boardId = boardIds[0] ?? '';
    expect(
      await saveStatusMappings(h.deps, owner(), boardId, [
        { jiraStatusId: '10003', category: 'todo', blocked: false },
        { jiraStatusId: '10003', category: 'done', blocked: false },
      ]),
    ).toEqual({ ok: true, updated: 1 });
    const done = (await listStatusMappings(h.deps, 'org_a', boardId)).find(
      (m) => m.jiraStatusId === '10003',
    );
    expect(done?.category).toBe('done');
  });

  it('seeds unknown statuses as to do', async () => {
    const first = h.dataset.boards[0];
    if (!first) throw new Error('no board');
    const original = first.columns;
    first.columns = [...original, { name: 'Ghost', statusIds: ['99999'] }];
    try {
      await runSync(h.deps, { orgId: 'org_a', connectionId, trigger: 'manual' });
    } finally {
      first.columns = original;
    }
    const board = (await listBoards(h.deps, 'org_a', connectionId)).find(
      (b) => b.name === first.name,
    );
    const ghost = (await listStatusMappings(h.deps, 'org_a', board?.id ?? '')).find(
      (m) => m.jiraStatusId === '99999',
    );
    expect(ghost).toMatchObject({ category: 'todo', blocked: false, source: 'auto' });
  });
});

describe('OAuth credentials', () => {
  let h: Awaited<ReturnType<typeof startSyncHarness>>;
  const tokens = (expiresAt: Date): AtlassianTokens => ({
    accessToken: () => 'access-1',
    refreshToken: () => 'refresh-1',
    accessTokenExpiresAt: () => expiresAt,
  });
  const oauthFor = (expiresAt: Date, refreshFails: boolean): AtlassianOAuthClient => ({
    createAuthorizationURL: () => new URL('https://auth.atlassian.com/authorize'),
    validateAuthorizationCode: async () => tokens(expiresAt),
    refreshAccessToken: async () => {
      if (refreshFails) throw new Error('invalid_grant');
      return tokens(expiresAt);
    },
  });
  beforeAll(async () => {
    h = await startSyncHarness();
  });
  afterAll(async () => h?.stop());

  const connectOAuth = async (orgId: string, oauth: AtlassianOAuthClient) => {
    const cdeps = {
      ...h.deps,
      oauth,
      listSites: async () => [{ id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme' }],
      testJira: async () => ({
        ok: true as const,
        deployment: 'cloud' as const,
        version: '1',
        account: { id: 'a', displayName: 'Pat' },
      }),
    };
    // biome-ignore lint/suspicious/noExplicitAny: OAuthDeps is not exported by the package
    await completeJiraOAuth(cdeps as any, owner(orgId), 'code');
    const [row] = await h.rawDb.query.jiraConnections.findMany({
      where: (t, { eq: is }) => is(t.orgId, orgId),
    });
    return row?.id ?? '';
  };

  it('opens the data source with a credentials provider', async () => {
    const oauth = oauthFor(new Date(Date.now() + 3_600_000), false);
    const id = await connectOAuth('org_o1', oauth);
    let seen: JiraCredentialsInput | undefined;
    const source = {
      listStatuses: async () => [],
      listBoards: async () => [],
    } as unknown as JiraDataSource;
    const deps: SyncDeps = {
      ...h.deps,
      oauth,
      createSource: (creds) => {
        seen = creds;
        return source;
      },
    };
    expect(await discoverBoards(deps, owner('org_o1'), id)).toEqual({ ok: true, boards: [] });
    expect(typeof seen).toBe('function');
    expect(await (seen as () => Promise<unknown>)()).toMatchObject({
      kind: 'cloud_oauth',
      accessToken: 'access-1',
    });
  });

  it('reports a missing OAuth client and an expired grant as codes', async () => {
    const id = await connectOAuth(
      'org_o2',
      oauthFor(new Date(Date.now() + 10_000), true), // inside the refresh window; refresh fails
    );
    expect(await discoverBoards(h.deps, owner('org_o2'), id)).toEqual({
      ok: false,
      code: 'oauth_unavailable',
    });
    const deps: SyncDeps = { ...h.deps, oauth: oauthFor(new Date(), true) };
    expect(await discoverBoards(deps, owner('org_o2'), id)).toEqual({
      ok: false,
      code: 'oauth_expired',
    });
  });
});
