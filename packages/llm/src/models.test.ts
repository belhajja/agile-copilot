import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchNoRedirect } from '@agile/net';
import { afterEach, describe, expect, it } from 'vitest';
import { listModels } from './models';
import { startMockOpenAI } from './testing/mock-openai-server';

/** Rewrites a fixed vendor host to a local mock server, keeping path and query. */
function pointFetchAt(origin: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const target = new URL(origin);
    url.protocol = target.protocol;
    url.hostname = target.hostname;
    url.port = target.port;
    return fetchNoRedirect(url, init);
  }) as typeof fetch;
}

/** A tiny Anthropic-shaped /v1/models endpoint, paged by after_id. */
async function startAnthropicMock(opts: { validKey: string; pages: string[][] }) {
  const lastIds = opts.pages.map((p) => p.at(-1));
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET' || !req.url?.startsWith('/v1/models')) return send(404, {});
    if (req.headers['x-api-key'] !== opts.validKey) {
      return send(401, { error: { message: 'invalid x-api-key' } });
    }
    if (req.headers['anthropic-version'] !== '2023-06-01') return send(400, {});
    const afterId = new URL(req.url, 'http://x').searchParams.get('after_id');
    const pageIndex = afterId ? lastIds.indexOf(afterId) + 1 : 0;
    const page = opts.pages[pageIndex] ?? [];
    send(200, {
      data: page.map((id) => ({ id, type: 'model' })),
      has_more: pageIndex < opts.pages.length - 1,
      last_id: page.at(-1) ?? null,
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** A tiny Google-shaped /v1beta/models endpoint, paged by an opaque pageToken. */
async function startGoogleMock(opts: {
  validKey: string;
  pages: { name: string; supportedGenerationMethods: string[] }[][];
}) {
  const tokenOf = (index: number) => `tok${index}`;
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET' || !req.url?.startsWith('/v1beta/models')) return send(404, {});
    if (req.headers['x-goog-api-key'] !== opts.validKey) {
      return send(401, { error: { message: 'invalid key' } });
    }
    const pageToken = new URL(req.url, 'http://x').searchParams.get('pageToken');
    const pageIndex = pageToken ? Number(pageToken.replace('tok', '')) : 0;
    const page = opts.pages[pageIndex] ?? [];
    const hasNext = pageIndex < opts.pages.length - 1;
    send(200, { models: page, ...(hasNext ? { nextPageToken: tokenOf(pageIndex + 1) } : {}) });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('listModels', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()?.();
  });

  it('lists an OpenAI key’s models', async () => {
    const mock = await startMockOpenAI({ validKey: 'good-key', models: ['gpt-4o', 'gpt-4o-mini'] });
    closers.push(mock.close);
    const r = await listModels(
      { provider: 'openai', apiKey: 'good-key' },
      { fetch: pointFetchAt(mock.baseUrl.replace('/v1', '')) },
    );
    expect(r).toEqual({ ok: true, models: ['gpt-4o', 'gpt-4o-mini'] });
  });

  it('rejects a bad OpenAI key as unauthorized', async () => {
    const mock = await startMockOpenAI({ validKey: 'good-key', models: ['gpt-4o'] });
    closers.push(mock.close);
    const r = await listModels(
      { provider: 'openai', apiKey: 'bad-key' },
      { fetch: pointFetchAt(mock.baseUrl.replace('/v1', '')) },
    );
    expect(r).toMatchObject({ ok: false, code: 'unauthorized' });
  });

  it('lists a Mistral key’s models at the fixed Mistral host', async () => {
    const mock = await startMockOpenAI({
      validKey: 'm-key',
      models: ['mistral-large', 'mistral-small'],
    });
    closers.push(mock.close);
    const r = await listModels(
      { provider: 'mistral', apiKey: 'm-key' },
      { fetch: pointFetchAt(mock.baseUrl.replace('/v1', '')) },
    );
    expect(r).toEqual({ ok: true, models: ['mistral-large', 'mistral-small'] });
  });

  it('lists an OpenAI-compatible server’s models at the configured base URL, key optional', async () => {
    const mock = await startMockOpenAI({ validKey: '', models: ['llama3.1', 'qwen3.5-122b'] });
    closers.push(mock.close);
    const r = await listModels({ provider: 'openai_compatible', baseUrl: mock.baseUrl }, {});
    expect(r).toEqual({ ok: true, models: ['llama3.1', 'qwen3.5-122b'] });
  });

  it('accepts a trailing slash on the configured base URL', async () => {
    const mock = await startMockOpenAI({ validKey: 'k', models: ['llama3.1'] });
    closers.push(mock.close);
    const r = await listModels(
      { provider: 'openai_compatible', baseUrl: `${mock.baseUrl}/`, apiKey: 'k' },
      {},
    );
    expect(r).toEqual({ ok: true, models: ['llama3.1'] });
  });

  it('pages through Anthropic’s model list up to the end', async () => {
    const mock = await startAnthropicMock({
      validKey: 'ant-key',
      pages: [['claude-sonnet-5-5', 'claude-haiku-5'], ['claude-opus-4-1']],
    });
    closers.push(mock.close);
    const r = await listModels(
      { provider: 'anthropic', apiKey: 'ant-key' },
      { fetch: pointFetchAt(mock.baseUrl) },
    );
    expect(r).toEqual({
      ok: true,
      models: ['claude-haiku-5', 'claude-opus-4-1', 'claude-sonnet-5-5'],
    });
  });

  it('rejects a bad Anthropic key as unauthorized', async () => {
    const mock = await startAnthropicMock({ validKey: 'ant-key', pages: [['claude-sonnet-5-5']] });
    closers.push(mock.close);
    const r = await listModels(
      { provider: 'anthropic', apiKey: 'wrong' },
      { fetch: pointFetchAt(mock.baseUrl) },
    );
    expect(r).toMatchObject({ ok: false, code: 'unauthorized' });
  });

  it('pages through Google’s model list, keeping only models that support generateContent', async () => {
    const mock = await startGoogleMock({
      validKey: 'g-key',
      pages: [
        [
          { name: 'models/gemini-1', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embed-1', supportedGenerationMethods: ['embedContent'] },
        ],
        [
          {
            name: 'models/gemini-2',
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
        ],
      ],
    });
    closers.push(mock.close);
    const r = await listModels(
      { provider: 'google', apiKey: 'g-key' },
      { fetch: pointFetchAt(mock.baseUrl) },
    );
    expect(r).toEqual({ ok: true, models: ['gemini-1', 'gemini-2'] });
  });

  it('rejects a bad Google key as unauthorized', async () => {
    const mock = await startGoogleMock({
      validKey: 'g-key',
      pages: [[{ name: 'models/gemini-1', supportedGenerationMethods: ['generateContent'] }]],
    });
    closers.push(mock.close);
    const r = await listModels(
      { provider: 'google', apiKey: 'wrong' },
      { fetch: pointFetchAt(mock.baseUrl) },
    );
    expect(r).toMatchObject({ ok: false, code: 'unauthorized' });
  });

  it('reports Azure as not supported, without any network call', async () => {
    const r = await listModels(
      { provider: 'azure', apiKey: 'k', resourceName: 'my-resource' },
      { fetch: () => Promise.reject(new Error('must not be called')) },
    );
    expect(r).toEqual({ ok: false, code: 'not_supported', message: expect.any(String) });
  });

  it.each([
    [403, 'forbidden'],
    [404, 'provider_error'],
    [429, 'rate_limited'],
    [500, 'provider_error'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const server = createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'nope' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    const r = await listModels(
      { provider: 'openai_compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' },
      {},
    );
    expect(r).toMatchObject({ ok: false, code });
  });

  it('maps a refused connection to unreachable', async () => {
    const server = createServer((_req, res) => res.end('{}'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((r) => server.close(() => r()));
    const r = await listModels(
      { provider: 'openai_compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' },
      {},
    );
    expect(r).toMatchObject({ ok: false, code: 'unreachable' });
  });

  it('does not follow redirects from the provider endpoint', async () => {
    let hits = 0;
    const recorder = createServer((_req, res) => {
      hits++;
      res.end('{"data":[]}');
    });
    await new Promise<void>((r) => recorder.listen(0, '127.0.0.1', r));
    const recPort = (recorder.address() as AddressInfo).port;
    closers.push(() => new Promise<void>((r) => recorder.close(() => r())));
    const redirector = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${recPort}/v1/models` });
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
    const port = (redirector.address() as AddressInfo).port;
    closers.push(() => new Promise<void>((r) => redirector.close(() => r())));
    const r = await listModels(
      { provider: 'openai_compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' },
      {},
    );
    expect(r).toMatchObject({ ok: false, code: 'unreachable' });
    expect(hits).toBe(0);
  });

  it('returns unique ids, sorted, capped at 500', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `m-${String(i).padStart(4, '0')}`);
    const duplicated = [
      ...ids,
      ...ids,
      ...Array.from({ length: 300 }, (_, i) => `n-${String(i).padStart(4, '0')}`),
    ];
    const mock = await startMockOpenAI({ validKey: 'k', models: duplicated });
    closers.push(mock.close);
    const r = await listModels(
      { provider: 'openai_compatible', baseUrl: mock.baseUrl, apiKey: 'k' },
      {},
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.models).toHaveLength(500);
    expect(r.models).toEqual([...r.models].sort());
    expect(new Set(r.models).size).toBe(500);
  });

  it('never includes the API key in the failure message', async () => {
    const secretKey = 'sk-super-secret-value-should-not-leak';
    const server = createServer((req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: `rejected request with header ${req.headers.authorization}` }),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    const r = await listModels(
      { provider: 'openai_compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: secretKey },
      {},
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(secretKey);
  });
});
