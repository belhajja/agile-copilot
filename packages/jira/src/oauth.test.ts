import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { atlassianOAuthFromEnv, listAccessibleJiraSites } from './oauth';

describe('listAccessibleJiraSites', () => {
  let base = '';
  const server = createServer((req, res) => {
    if (req.url === '/redir/oauth/token/accessible-resources') {
      res.writeHead(302, { location: 'http://127.0.0.1:1/internal' }).end();
      return;
    }
    if (
      req.url !== '/oauth/token/accessible-resources' ||
      req.headers.authorization !== 'Bearer at-1'
    ) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify([
        {
          id: 'c-1',
          url: 'https://acme.atlassian.net',
          name: 'acme',
          scopes: ['read:jira-work', 'write:jira-work'],
        },
        {
          id: 'c-2',
          url: 'https://acme-wiki.atlassian.net',
          name: 'wiki',
          scopes: ['read:confluence-content.all'],
        },
      ]),
    );
  });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('returns only sites granted Jira scopes', async () => {
    expect(await listAccessibleJiraSites('at-1', { apiBase: base })).toEqual([
      { id: 'c-1', url: 'https://acme.atlassian.net', name: 'acme' },
    ]);
  });

  it('throws on a rejected token', async () => {
    await expect(listAccessibleJiraSites('bad', { apiBase: base })).rejects.toThrow(/401/);
  });

  it('does not follow redirects', async () => {
    await expect(listAccessibleJiraSites('at-1', { apiBase: `${base}/redir` })).rejects.toThrow(
      /302/,
    );
  });
});

describe('atlassianOAuthFromEnv', () => {
  const base = { BETTER_AUTH_URL: 'https://copilot.example.com/' };

  it('is null when the client id or secret is missing', () => {
    expect(atlassianOAuthFromEnv(base)).toBeNull();
    expect(atlassianOAuthFromEnv({ ...base, ATLASSIAN_OAUTH_CLIENT_ID: 'id' })).toBeNull();
  });

  it('sends users back to the app callback', () => {
    const client = atlassianOAuthFromEnv({
      ...base,
      ATLASSIAN_OAUTH_CLIENT_ID: 'id',
      ATLASSIAN_OAUTH_CLIENT_SECRET: 'secret',
    });
    const url = client?.createAuthorizationURL('state-1', ['read:jira-work']);
    expect(url?.searchParams.get('client_id')).toBe('id');
    expect(url?.searchParams.get('redirect_uri')).toBe(
      'https://copilot.example.com/api/jira/oauth/callback',
    );
  });
});
