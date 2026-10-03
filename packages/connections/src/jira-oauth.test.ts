import { auditLog } from '@agile/db';
import type { AtlassianOAuthClient, AtlassianTokens, JiraCredentials } from '@agile/jira';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createJiraConnection,
  listJiraConnections,
  loadJiraSecret,
  retestJiraConnection,
} from './jira-connections';
import { completeJiraOAuth, getFreshJiraCredentials, OAuthTimeoutError } from './jira-oauth';
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
    expect(await completeJiraOAuth(deps(), owner(), 'good-code')).toEqual({
      ok: true,
      created: 1,
      updated: 0,
    });
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

  it('shares one rotating refresh token across sites and refreshes the grant once', async () => {
    refreshCalls = 0;
    const two = {
      ...deps(),
      listSites: vi.fn(async () => [
        { id: 'cloud-a', url: 'https://a.atlassian.net', name: 'a' },
        { id: 'cloud-b', url: 'https://b.atlassian.net', name: 'b' },
      ]),
    };
    expect(await completeJiraOAuth(two, owner('org_g'), 'good-code')).toEqual({
      ok: true,
      created: 2,
      updated: 0,
    });
    const list = await listJiraConnections(deps(), 'org_g');
    const [x, y] = [list[0]?.id ?? '', list[1]?.id ?? ''];
    const [ra, rb] = await Promise.all([
      getFreshJiraCredentials(deps(), 'org_g', x),
      getFreshJiraCredentials(deps(), 'org_g', y),
    ]);
    expect(refreshCalls).toBe(1);
    expect(ra).toMatchObject({ accessToken: 'access-2' });
    expect(rb).toMatchObject({ accessToken: 'access-2' });
    for (const id of [x, y]) {
      expect((await loadJiraSecret(deps(), 'org_g', id))?.oauth?.refreshToken).toBe('refresh-2');
    }
    const secrets = await Promise.all([x, y].map((id) => loadJiraSecret(deps(), 'org_g', id)));
    expect(
      new Set(secrets.map((s) => (s?.credentials as { cloudId: string } | undefined)?.cloudId)),
    ).toEqual(new Set(['cloud-a', 'cloud-b']));
  });

  it('reconnecting an OAuth site rewrites its tokens; API-token connections are untouched', async () => {
    const first = await completeJiraOAuth(deps(), owner('org_r'), 'good-code');
    expect(first).toEqual({ ok: true, created: 1, updated: 0 });
    const [c] = await listJiraConnections(deps(), 'org_r');
    const second = {
      ...deps(),
      oauth: { ...oauth, validateAuthorizationCode: async () => tokens(7, later) },
    };
    expect(await completeJiraOAuth(second, owner('org_r'), 'good-code')).toEqual({
      ok: true,
      created: 0,
      updated: 1,
    });
    expect(await loadJiraSecret(deps(), 'org_r', c?.id ?? '')).toMatchObject({
      credentials: { accessToken: 'access-7' },
      oauth: { refreshToken: 'refresh-7' },
    });

    const basic = await createJiraConnection(deps(), owner('org_s'), {
      name: 'basic',
      credentials: {
        kind: 'cloud_basic',
        baseUrl: 'https://acme.atlassian.net',
        email: 'a@b.co',
        apiToken: 'tok',
      },
    });
    expect(basic.ok).toBe(true);
    expect(await completeJiraOAuth(deps(), owner('org_s'), 'good-code')).toEqual({
      ok: false,
      code: 'duplicate',
    });
    const [b] = await listJiraConnections(deps(), 'org_s');
    expect(b?.authType).toBe('basic');
    expect((await loadJiraSecret(deps(), 'org_s', b?.id ?? ''))?.credentials.kind).toBe(
      'cloud_basic',
    );
  });

  it('times out a hung refresh, leaving the stored secret unchanged', async () => {
    const hung: AtlassianOAuthClient = {
      ...oauth,
      refreshAccessToken: () => new Promise(() => {}),
    };
    await completeJiraOAuth(deps(), owner('org_t'), 'good-code');
    const [c] = await listJiraConnections(deps(), 'org_t');
    const id = c?.id ?? '';
    await expect(
      getFreshJiraCredentials({ ...deps(), oauth: hung, oauthTimeoutMs: 50 }, 'org_t', id),
    ).rejects.toBeInstanceOf(OAuthTimeoutError);
    expect(await loadJiraSecret(deps(), 'org_t', id)).toMatchObject({
      credentials: { accessToken: 'access-1' },
      oauth: { refreshToken: 'refresh-1' },
    });
  });

  it('reports the probe failure when no site could be connected', async () => {
    const failing = {
      ...deps(),
      testJira: async () => ({
        ok: false as const,
        code: 'forbidden' as const,
        message: 'Jira refused access with this token.',
      }),
    };
    expect(await completeJiraOAuth(failing, owner('org_f'), 'good-code')).toEqual({
      ok: false,
      code: 'forbidden',
    });
    expect(await listJiraConnections(deps(), 'org_f')).toEqual([]);
  });

  it('retest refreshes an expiring OAuth token once, then probes with the new token', async () => {
    refreshCalls = 0;
    await completeJiraOAuth(deps(), owner('org_rt'), 'good-code');
    const [c] = await listJiraConnections(deps(), 'org_rt');
    const id = c?.id ?? '';
    const seen: string[] = [];
    const probing = {
      ...deps(),
      testJira: async (creds: JiraCredentials) => {
        if (creds.kind === 'cloud_oauth') seen.push(creds.accessToken);
        return okJira('Pat Cloud')(creds);
      },
    };
    expect(await retestJiraConnection(probing, owner('org_rt'), id)).toMatchObject({
      ok: true,
      connection: { status: 'ok', lastError: null },
    });
    expect(refreshCalls).toBe(1);
    expect(seen).toEqual(['access-2']);
    expect(await loadJiraSecret(deps(), 'org_rt', id)).toMatchObject({
      credentials: { accessToken: 'access-2' },
      oauth: { refreshToken: 'refresh-2' },
    });
  });

  it('retest records oauth_expired when the refresh is rejected, keeping the secret', async () => {
    const rejecting: AtlassianOAuthClient = {
      ...oauth,
      refreshAccessToken: async () => {
        throw new Error('invalid_grant');
      },
    };
    await completeJiraOAuth(deps(), owner('org_rx'), 'good-code');
    const [c] = await listJiraConnections(deps(), 'org_rx');
    const id = c?.id ?? '';
    const r = await retestJiraConnection({ ...deps(), oauth: rejecting }, owner('org_rx'), id);
    expect(r).toMatchObject({
      ok: true,
      connection: { status: 'error', lastError: 'oauth_expired' },
    });
    expect(JSON.stringify(r)).not.toContain('refresh-1');
    expect(await loadJiraSecret(deps(), 'org_rx', id)).toMatchObject({
      credentials: { accessToken: 'access-1' },
      oauth: { refreshToken: 'refresh-1' },
    });
    const audits = await h.rawDb.select().from(auditLog).where(eq(auditLog.targetId, id));
    expect(audits.find((a) => a.action === 'jira_connection.retested')?.metadata).toEqual({
      ok: false,
      code: 'oauth_expired',
    });
  });
});
