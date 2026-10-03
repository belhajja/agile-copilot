import type { AtlassianOAuthClient, AtlassianTokens } from '@agile/jira';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { listJiraConnections, loadJiraSecret } from './jira-connections';
import { completeJiraOAuth, getFreshJiraCredentials } from './jira-oauth';
import { keyring, okJira, owner, startHarness } from './test-helpers';

const tokens = (n: number, expiresAt: Date): AtlassianTokens => ({
  accessToken: () => `access-${n}`,
  refreshToken: () => `refresh-${n}`,
  accessTokenExpiresAt: () => expiresAt,
});

describe('Atlassian OAuth', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  const soon = new Date(Date.now() + 30_000); // expires within the 60 s refresh window
  const later = new Date(Date.now() + 3_600_000);
  let refreshCalls = 0;
  const oauth: AtlassianOAuthClient = {
    createAuthorizationURL: () => new URL('https://auth.atlassian.com/authorize'),
    validateAuthorizationCode: async (code) => {
      if (code !== 'good-code') throw new Error('invalid_grant');
      return tokens(1, soon);
    },
    refreshAccessToken: async (rt) => {
      refreshCalls++;
      await new Promise((r) => setTimeout(r, 50));
      if (rt !== 'refresh-1') throw new Error('refresh token reused');
      return tokens(2, later);
    },
  };

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => h?.stop());

  const deps = () => ({
    db: h.db,
    keyring,
    allowedPrivateHosts: [],
    testJira: okJira('Pat Cloud'),
    oauth,
    listSites: vi.fn(async () => [
      { id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme' },
    ]),
  });

  it('creates one connection per Jira site with encrypted tokens', async () => {
    expect(await completeJiraOAuth(deps(), owner(), 'good-code')).toEqual({ ok: true, created: 1 });
    const [c] = await listJiraConnections(deps(), 'org_a');
    expect(c).toMatchObject({
      authType: 'oauth',
      deployment: 'cloud',
      baseUrl: 'https://acme.atlassian.net',
    });
    const secret = await loadJiraSecret(deps(), 'org_a', c?.id ?? '');
    expect(secret).toMatchObject({
      credentials: { kind: 'cloud_oauth', cloudId: 'cloud-1', accessToken: 'access-1' },
      oauth: { refreshToken: 'refresh-1' },
    });
  });

  it('reports a failed code exchange and accounts without Jira sites', async () => {
    expect(await completeJiraOAuth(deps(), owner(), 'bad')).toEqual({
      ok: false,
      code: 'oauth_failed',
    });
    const noSites = { ...deps(), listSites: vi.fn(async () => []) };
    expect(await completeJiraOAuth(noSites, owner('org_c'), 'good-code')).toEqual({
      ok: false,
      code: 'oauth_no_sites',
    });
  });

  it('refreshes an expiring token exactly once under concurrency and persists the rotated token', async () => {
    const [c] = await listJiraConnections(deps(), 'org_a');
    const id = c?.id ?? '';
    const [a, b] = await Promise.all([
      getFreshJiraCredentials(deps(), 'org_a', id),
      getFreshJiraCredentials(deps(), 'org_a', id),
    ]);
    expect(refreshCalls).toBe(1);
    expect(a).toMatchObject({ kind: 'cloud_oauth', accessToken: 'access-2' });
    expect(b).toMatchObject({ kind: 'cloud_oauth', accessToken: 'access-2' });
    expect((await loadJiraSecret(deps(), 'org_a', id))?.oauth?.refreshToken).toBe('refresh-2');
  });

  it('returns null for another org', async () => {
    const [c] = await listJiraConnections(deps(), 'org_a');
    expect(await getFreshJiraCredentials(deps(), 'org_b', c?.id ?? '')).toBeNull();
  });
});
