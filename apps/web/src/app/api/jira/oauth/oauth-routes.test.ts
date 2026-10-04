import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route handlers run against stubs of the request cookies, the session and the OAuth service.
const jar = new Map<string, { value: string; options?: Record<string, unknown> }>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const c = jar.get(name);
      return c ? { name, value: c.value } : undefined;
    },
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      jar.set(name, { value, options });
    },
    delete: (opts: string | { name: string }) => {
      jar.delete(typeof opts === 'string' ? opts : opts.name);
    },
  }),
}));

const owner = {
  orgId: 'org_a',
  userId: 'user_1',
  roles: ['owner'],
  user: { id: 'user_1', name: 'Pat', email: 'pat@example.com' },
};
const requireActor = vi.fn(async () => owner);
vi.mock('@/server/context', () => ({
  requireActor: () => requireActor(),
  services: () => ({ env: { BETTER_AUTH_URL: 'http://localhost:3200' } }),
  connectionDeps: () => ({ deps: 'stub' }),
}));

const oauthClient = {
  createAuthorizationURL: (state: string) =>
    new URL(`https://auth.atlassian.com/authorize?state=${state}`),
};
let oauthConfigured = true;
vi.mock('@/server/atlassian', () => ({
  OAUTH_STATE_COOKIE: 'jira_oauth_state',
  atlassianOAuth: () => (oauthConfigured ? oauthClient : null),
}));

const completeJiraOAuth = vi.fn();
vi.mock('@agile/connections', () => ({
  completeJiraOAuth: (...args: unknown[]) => completeJiraOAuth(...args),
}));

const { GET: start } = await import('./start/route');
const { GET: callback } = await import('./callback/route');

const callbackRequest = (query: string) =>
  new NextRequest(`http://localhost:3200/api/jira/oauth/callback?${query}`);
const location = (res: Response) => res.headers.get('location');

describe('GET /api/jira/oauth/start', () => {
  beforeEach(() => {
    jar.clear();
    oauthConfigured = true;
    requireActor.mockResolvedValue(owner);
  });

  it('binds a fresh state to the active workspace and redirects to Atlassian', async () => {
    const res = await start();
    const cookie = jar.get('jira_oauth_state');
    const [state, orgId] = cookie?.value.split('.') ?? [];
    expect(orgId).toBe('org_a');
    expect(state).toMatch(/^[\w-]{20,}$/);
    expect(cookie?.options).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/api/jira/oauth',
      maxAge: 600,
      secure: false, // BETTER_AUTH_URL is http in this test
    });
    expect(location(res)).toBe(`https://auth.atlassian.com/authorize?state=${state}`);
  });

  it.each(['viewer', 'manager'])('sends a %s back without starting a flow', async (role) => {
    requireActor.mockResolvedValue({ ...owner, roles: [role] });
    const res = await start();
    expect(location(res)).toBe('http://localhost:3200/settings/jira?error=forbidden_role');
    expect(jar.size).toBe(0);
  });

  it('reports OAuth as unavailable when the app is not configured', async () => {
    oauthConfigured = false;
    const res = await start();
    expect(location(res)).toBe('http://localhost:3200/settings/jira?error=oauth_failed');
    expect(jar.size).toBe(0);
  });
});

describe('GET /api/jira/oauth/callback', () => {
  beforeEach(() => {
    jar.clear();
    oauthConfigured = true;
    requireActor.mockResolvedValue(owner);
    completeJiraOAuth.mockReset();
    completeJiraOAuth.mockResolvedValue({ ok: true, created: 2, updated: 1 });
  });

  const withState = (value: string) => jar.set('jira_oauth_state', { value });

  it('completes the flow for the workspace that started it', async () => {
    withState('st4te.org_a');
    const res = await callback(callbackRequest('code=c0de&state=st4te'));
    expect(location(res)).toBe('http://localhost:3200/settings/jira?connected=3');
    expect(completeJiraOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ deps: 'stub', oauth: oauthClient }),
      owner,
      'c0de',
    );
    expect(jar.has('jira_oauth_state')).toBe(false); // single use
  });

  it.each([
    ['a state that does not match the cookie', 'st4te.org_a', 'code=c0de&state=other'],
    ['a missing state cookie', undefined, 'code=c0de&state=st4te'],
    ['a missing code', 'st4te.org_a', 'state=st4te'],
    ['a flow started in another workspace', 'st4te.org_b', 'code=c0de&state=st4te'],
    ['a cookie without a workspace part', 'st4te', 'code=c0de&state=st4te'],
  ])('rejects %s', async (_case, cookie, query) => {
    if (cookie) withState(cookie);
    const res = await callback(callbackRequest(query));
    expect(location(res)).toBe('http://localhost:3200/settings/jira?error=oauth_failed');
    expect(completeJiraOAuth).not.toHaveBeenCalled();
    expect(jar.has('jira_oauth_state')).toBe(false);
  });

  it('keeps dots inside the workspace id (splits on the first dot only)', async () => {
    requireActor.mockResolvedValue({ ...owner, orgId: 'org.with.dots' });
    withState('st4te.org.with.dots');
    const res = await callback(callbackRequest('code=c0de&state=st4te'));
    expect(location(res)).toBe('http://localhost:3200/settings/jira?connected=3');
  });

  it.each(['viewer', 'manager'])('sends a %s back before exchanging the code', async (role) => {
    requireActor.mockResolvedValue({ ...owner, roles: [role] });
    withState('st4te.org_a');
    const res = await callback(callbackRequest('code=c0de&state=st4te'));
    expect(location(res)).toBe('http://localhost:3200/settings/jira?error=forbidden_role');
    expect(completeJiraOAuth).not.toHaveBeenCalled();
  });

  it('passes a service failure code through to the settings page', async () => {
    completeJiraOAuth.mockResolvedValue({ ok: false, code: 'oauth_no_sites' });
    withState('st4te.org_a');
    const res = await callback(callbackRequest('code=c0de&state=st4te'));
    expect(location(res)).toBe('http://localhost:3200/settings/jira?error=oauth_no_sites');
  });
});
