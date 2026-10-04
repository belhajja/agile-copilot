import { jiraSyncStates } from '@agile/db';
import type { AtlassianOAuthClient, AtlassianTokens } from '@agile/jira';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ConnectionDeps,
  createJiraConnection,
  listJiraConnections,
  retestJiraConnection,
} from './jira-connections';
import { completeJiraOAuth } from './jira-oauth';
import { keyring, okJira, owner, startHarness } from './test-helpers';

const tokens = (n: number): AtlassianTokens => ({
  accessToken: () => `access-${n}`,
  refreshToken: () => `refresh-${n}`,
  accessTokenExpiresAt: () => new Date(Date.now() + 3_600_000),
});

describe('a fixed connection clears its stored sync error', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let deps: ConnectionDeps;
  beforeAll(async () => {
    h = await startHarness();
    deps = { db: h.db, keyring, allowedPrivateHosts: [], testJira: okJira() };
  });
  afterAll(async () => h?.stop());

  const failSync = (orgId: string, connectionId: string, lastError: string, status = 'error') =>
    h.rawDb
      .insert(jiraSyncStates)
      .values({ orgId, connectionId, status: status as 'error', lastError })
      .onConflictDoUpdate({
        target: jiraSyncStates.connectionId,
        set: { status: status as 'error', lastError },
      });
  const stateOf = async (connectionId: string) => {
    const [s] = await h.rawDb
      .select()
      .from(jiraSyncStates)
      .where(eq(jiraSyncStates.connectionId, connectionId));
    return s;
  };

  it('after a successful retest (and only then)', async () => {
    const created = await createJiraConnection(deps, owner('org_r1'), {
      name: 'Corp',
      credentials: { kind: 'datacenter_pat', baseUrl: 'https://jira.corp.example', token: 'pat' },
    });
    if (!created.ok) throw new Error('setup');
    const id = created.connection.id;
    await failSync('org_r1', id, 'unauthorized');
    const failing: ConnectionDeps = {
      ...deps,
      testJira: async () => ({ ok: false, code: 'unauthorized', message: 'no' }),
    };
    await retestJiraConnection(failing, owner('org_r1'), id);
    expect(await stateOf(id)).toMatchObject({ status: 'error', lastError: 'unauthorized' });
    await retestJiraConnection(deps, owner('org_r1'), id);
    expect(await stateOf(id)).toMatchObject({ status: 'idle', lastError: null });
    // A run in progress keeps its status.
    await failSync('org_r1', id, 'blocked_url', 'running');
    await retestJiraConnection(deps, owner('org_r1'), id);
    expect(await stateOf(id)).toMatchObject({ status: 'running', lastError: null });
  });

  it('after an OAuth reconnect', async () => {
    const oauthFor = (n: number): AtlassianOAuthClient => ({
      createAuthorizationURL: () => new URL('https://auth.atlassian.com/authorize'),
      validateAuthorizationCode: async () => tokens(n),
      refreshAccessToken: async () => tokens(n),
    });
    const oauthDeps = (n: number) => ({
      ...deps,
      testJira: okJira('Pat Cloud'),
      oauth: oauthFor(n),
      listSites: async () => [{ id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme' }],
    });
    expect(await completeJiraOAuth(oauthDeps(1), owner('org_r2'), 'code')).toMatchObject({
      ok: true,
      created: 1,
    });
    const [c] = await listJiraConnections(deps, 'org_r2');
    await failSync('org_r2', c?.id ?? '', 'oauth_expired');
    expect(await completeJiraOAuth(oauthDeps(2), owner('org_r2'), 'code')).toMatchObject({
      ok: true,
      updated: 1,
    });
    expect(await stateOf(c?.id ?? '')).toMatchObject({ status: 'idle', lastError: null });
  });
});
