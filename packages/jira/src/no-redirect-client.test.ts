import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RedirectBlockedError } from '@agile/net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNoRedirectClient, JiraHttpError, parseRetryAfter } from './no-redirect-client';

interface Seen {
  method?: string;
  url?: string;
  authorization?: string;
  contentType?: string;
  body: string;
}

describe('createNoRedirectClient', () => {
  let server: Server;
  let base = '';
  let seen: Seen[] = [];
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => resolve(body));
    });

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      seen.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: await read(req),
      });
      if (req.url?.startsWith('/redirect')) {
        res.writeHead(302, { location: 'http://127.0.0.1:1/internal' }).end();
      } else if (req.url?.startsWith('/limited')) {
        res.writeHead(429, { 'retry-after': '7' }).end();
      } else if (req.url?.startsWith('/empty')) {
        res.writeHead(204).end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"1","extra":true}');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  beforeEach(() => {
    seen = [];
  });

  const client = () =>
    createNoRedirectClient({ host: `${base}/`, auth: { type: 'bearer', token: 'tok' } });

  it('sends a JSON body with POST and PUT', async () => {
    await client().sendRequest({ url: '/rest/x', method: 'POST', body: { jql: 'a = b' } });
    await client().sendRequest({ url: 'rest/y', method: 'PUT', body: { n: 1 } });
    expect(seen).toMatchObject([
      { method: 'POST', url: '/rest/x', contentType: 'application/json', body: '{"jql":"a = b"}' },
      { method: 'PUT', url: '/rest/y', contentType: 'application/json', body: '{"n":1}' },
    ]);
  });

  it('never lets a caller header replace the credentials', async () => {
    await client().sendRequest({
      url: '/rest/x',
      headers: { authorization: 'Bearer evil', Authorization: 'Bearer worse' },
    });
    expect(seen[0]?.authorization).toBe('Bearer tok');
  });

  it('encodes search params like jira.js and skips missing ones', async () => {
    await client().sendRequest({
      url: '/rest/search',
      searchParams: {
        jql: 'project = A',
        nextPageToken: undefined,
        fields: ['summary', 'status'],
        maxResults: 50,
        startAt: null,
      },
    });
    const url = new URL(seen[0]?.url ?? '', base);
    expect(url.searchParams.getAll('fields')).toEqual(['summary', 'status']);
    expect(url.searchParams.get('jql')).toBe('project = A');
    expect(url.searchParams.get('maxResults')).toBe('50');
    expect(url.searchParams.has('nextPageToken')).toBe(false);
    expect(url.searchParams.has('startAt')).toBe(false);
  });

  it('refuses redirects', async () => {
    await expect(client().sendRequest({ url: '/redirect' })).rejects.toMatchObject({
      name: 'RedirectBlockedError',
      status: 302,
    });
    await expect(client().sendRequest({ url: '/redirect' })).rejects.toBeInstanceOf(
      RedirectBlockedError,
    );
  });

  it('surfaces the status and Retry-After of a failed request', async () => {
    const err = await client()
      .sendRequest({ url: '/limited' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraHttpError);
    expect(err).toMatchObject({ status: 429, retryAfterMs: 7_000 });
  });

  it('returns undefined for 204', async () => {
    expect(await client().sendRequest({ url: '/empty', method: 'DELETE' })).toBeUndefined();
  });

  it('validates strictly by default and passes raw JSON in lenient mode', async () => {
    const schema = z.object({ id: z.number() });
    await expect(client().sendRequest({ url: '/ok', schema })).rejects.toMatchObject({
      name: 'SchemaMismatchError',
    });
    const lenient = createNoRedirectClient({
      host: base,
      auth: { type: 'basic', email: 'a@b.c', apiToken: 't' },
      schemaValidation: 'lenient',
    });
    expect(await lenient.sendRequest({ url: '/ok', schema })).toEqual({ id: '1', extra: true });
    expect(seen.at(-1)?.authorization).toBe(`Basic ${Buffer.from('a@b.c:t').toString('base64')}`);
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates, ignores garbage', () => {
    const now = Date.parse('2026-10-04T10:00:00Z');
    expect(parseRetryAfter('3', now)).toBe(3_000);
    expect(parseRetryAfter('Sun, 04 Oct 2026 10:00:05 GMT', now)).toBe(5_000);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});
