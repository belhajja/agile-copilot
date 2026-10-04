import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createJiraDataSource, type JiraDataSource } from './data-source';
import { mapJiraError } from './errors';
import { JiraPaginationError, JiraPaginationLimitError } from './pagination';
import { errorRetryAfterMs, errorStatus } from './rate-limit';
import { demoDataset, startMockJira } from './testing/mock-jira-server';
import type { JiraCredentials } from './types';

const noWait = { sleep: async () => {} };
const PAT = 'secret-pat-123';

type Handler = (path: string, q: URLSearchParams, hit: number) => unknown;

let servers: Server[] = [];
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  servers = [];
});

/** A server that answers every request with whatever `handler` returns (200 JSON). */
async function hostile(handler: Handler, raw?: (hit: number) => string) {
  let hit = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    hit++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(raw ? raw(hit) : JSON.stringify(handler(url.pathname, url.searchParams, hit)));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits: () => hit };
}

const cloudCreds = (url: string): JiraCredentials => ({
  kind: 'cloud_basic',
  baseUrl: url,
  email: 'a@b.c',
  apiToken: 't',
});
const dcCreds = (url: string): JiraCredentials => ({
  kind: 'datacenter_pat',
  baseUrl: url,
  token: PAT,
});
const issue = (n: number) => ({ id: String(n), key: `A-${n}`, fields: {} });
const drain = async (source: JiraDataSource) => {
  const pages: number[] = [];
  for await (const p of source.searchIssues('filter = 1', ['summary'])) pages.push(p.length);
  return pages;
};

describe('pagination against hostile servers', () => {
  it('Cloud search throws when a page token repeats', async () => {
    const s = await hostile(() => ({ issues: [issue(1)], nextPageToken: 'same' }));
    const source = createJiraDataSource(cloudCreds(s.url), { retry: noWait });
    await expect(drain(source)).rejects.toMatchObject({
      name: 'JiraPaginationError',
      reason: 'repeated_token',
    });
    expect(s.hits()).toBeLessThanOrEqual(2);
  });

  it('Cloud search with endless fresh tokens hits the page cap', async () => {
    const s = await hostile((_p, _q, hit) => ({ issues: [issue(hit)], nextPageToken: `t${hit}` }));
    const source = createJiraDataSource(cloudCreds(s.url), { retry: noWait, maxPages: 5 });
    const err = await drain(source).catch((e) => e);
    expect(err).toBeInstanceOf(JiraPaginationLimitError);
    expect(err.message).not.toContain('127.0.0.1');
    expect(s.hits()).toBeLessThanOrEqual(6);
  });

  it.each([
    ['Cloud', cloudCreds],
    ['Data Center', dcCreds],
  ])('%s boards: endless full pages without total/isLast hit the page cap', async (_n, creds) => {
    const s = await hostile((_p, q, hit) => ({
      values: Array.from({ length: Number(q.get('maxResults')) }, (_, i) => ({
        id: hit * 1000 + i,
        name: 'b',
        type: 'scrum',
      })),
    }));
    const source = createJiraDataSource(creds(s.url), { retry: noWait, maxPages: 5 });
    await expect(source.listBoards()).rejects.toBeInstanceOf(JiraPaginationLimitError);
    expect(s.hits()).toBeLessThanOrEqual(6);
  });

  it.each([
    ['Cloud', cloudCreds],
    ['Data Center', dcCreds],
  ])('%s boards: the item cap applies', async (_n, creds) => {
    const s = await hostile((_p, q, hit) => ({
      values: Array.from({ length: Number(q.get('maxResults')) }, (_, i) => ({
        id: hit * 1000 + i,
        name: 'b',
        type: 'scrum',
      })),
    }));
    const source = createJiraDataSource(creds(s.url), { retry: noWait, maxItems: 120 });
    await expect(source.listBoards()).rejects.toBeInstanceOf(JiraPaginationLimitError);
  });

  it.each([
    ['Cloud', cloudCreds],
    ['Data Center', dcCreds],
  ])(
    '%s boards: stops on a short page when neither total nor isLast is given',
    async (_n, creds) => {
      const short = await hostile(() => ({ values: [{ id: 1, name: 'b', type: 'scrum' }] }));
      expect(
        await createJiraDataSource(creds(short.url), { retry: noWait }).listBoards(),
      ).toHaveLength(1);
      expect(short.hits()).toBe(1);
    },
  );

  it.each([
    ['Cloud', cloudCreds],
    ['Data Center', dcCreds],
  ])('%s boards: throws (not truncates) when startAt is ignored', async (_n, creds) => {
    const same = await hostile((_p, q) => ({
      values: Array.from({ length: Number(q.get('maxResults')) }, (_, i) => ({
        id: i,
        name: 'b',
        type: 'scrum',
      })),
    }));
    const err = await createJiraDataSource(creds(same.url), { retry: noWait })
      .listBoards()
      .catch((e) => e);
    expect(err).toBeInstanceOf(JiraPaginationError);
    expect(err).toMatchObject({ reason: 'repeated_page' });
    expect(err.message).not.toContain('127.0.0.1');
    expect(same.hits()).toBe(2);
  });

  it.each([
    ['Cloud', cloudCreds],
    ['Data Center', dcCreds],
  ])(
    '%s: an explicit isLast:false continues past a short page (boards and sprints)',
    async (_n, creds) => {
      const pages = (hit: number) =>
        hit === 1
          ? { isLast: false, values: [{ id: 1, name: 'a', type: 'scrum', state: 'closed' }] }
          : { isLast: true, values: [{ id: 2, name: 'b', type: 'scrum', state: 'closed' }] };
      const boards = await hostile((_p, _q, hit) => pages(hit));
      const listed = await createJiraDataSource(creds(boards.url), { retry: noWait }).listBoards();
      expect(listed.map((b) => b.jiraBoardId)).toEqual([1, 2]);
      const sprints = await hostile((_p, _q, hit) => pages(hit));
      const sp = await createJiraDataSource(creds(sprints.url), { retry: noWait }).listSprints(1);
      expect(sp.map((x) => x.jiraSprintId)).toEqual([1, 2]);
    },
  );

  it.each([
    ['Cloud', cloudCreds],
    ['Data Center', dcCreds],
  ])('%s: items repeated across overlapping pages are kept once', async (_n, creds) => {
    const row = (id: number) => ({ id, name: `b${id}`, type: 'scrum' });
    const s = await hostile((_p, _q, hit) =>
      hit === 1
        ? { isLast: false, values: [row(1), row(2)] }
        : { isLast: true, values: [row(2), row(3)] },
    );
    const boards = await createJiraDataSource(creds(s.url), { retry: noWait }).listBoards();
    expect(boards.map((b) => b.jiraBoardId)).toEqual([1, 2, 3]);
  });

  it('Data Center search: endless full pages cap; short page without total stops; ignored startAt stops', async () => {
    const endless = await hostile((_p, q, hit) => ({
      issues: Array.from({ length: Number(q.get('maxResults')) }, (_, i) => issue(hit * 1000 + i)),
    }));
    await expect(
      drain(
        createJiraDataSource(dcCreds(endless.url), { retry: noWait, pageSize: 10, maxPages: 5 }),
      ),
    ).rejects.toBeInstanceOf(JiraPaginationLimitError);

    const short = await hostile(() => ({ issues: [issue(1)] }));
    expect(
      await drain(createJiraDataSource(dcCreds(short.url), { retry: noWait, pageSize: 10 })),
    ).toEqual([1]);

    const same = await hostile((_p, q) => ({
      issues: Array.from({ length: Number(q.get('maxResults')) }, (_, i) => issue(i)),
    }));
    await expect(
      drain(createJiraDataSource(dcCreds(same.url), { retry: noWait, pageSize: 10 })),
    ).rejects.toMatchObject({ name: 'JiraPaginationError', reason: 'repeated_page' });
  });

  it('Cloud changelog and sprints are bounded too', async () => {
    const s = await hostile((_p, q, hit) => ({
      values: Array.from({ length: Number(q.get('maxResults')) }, (_, i) => ({
        id: hit * 1000 + i,
        created: '2026-01-01T00:00:00.000+0000',
        items: [],
        name: 's',
        state: 'closed',
      })),
    }));
    const source = createJiraDataSource(cloudCreds(s.url), { retry: noWait, maxPages: 3 });
    await expect(source.getFullChangelog('A-1')).rejects.toBeInstanceOf(JiraPaginationLimitError);
    await expect(source.listSprints(1)).rejects.toBeInstanceOf(JiraPaginationLimitError);
  });
});

describe('Data Center errors never carry the PAT', () => {
  const leaks = (err: unknown) => [
    JSON.stringify(err),
    String(err),
    (err as Error).stack ?? '',
    inspect(err, { depth: 10, showHidden: true }),
  ];

  it('sanitises an HTTP 401', async () => {
    const mock = await startMockJira({
      flavor: 'datacenter',
      validAuthorization: 'Bearer other',
      dataset: demoDataset(new Date()),
    });
    try {
      const err = await createJiraDataSource(dcCreds(mock.url), { retry: noWait })
        .listBoards()
        .catch((e) => e);
      expect(errorStatus(err)).toBe(401);
      expect(mapJiraError(err).code).toBe('unauthorized');
      expect(err.cause).toBeUndefined();
      for (const text of leaks(err)) expect(text).not.toContain(PAT);
    } finally {
      await mock.close();
    }
  });

  it('keeps Retry-After on a sanitised 429', async () => {
    const mock = await startMockJira({
      flavor: 'datacenter',
      validAuthorization: `Bearer ${PAT}`,
      dataset: demoDataset(new Date()),
      rateLimitFirst: 100,
      retryAfterSeconds: 7,
    });
    try {
      const err = await createJiraDataSource(dcCreds(mock.url), {
        retry: { ...noWait, maxRetries: 0 },
      })
        .listBoards()
        .catch((e) => e);
      expect(errorStatus(err)).toBe(429);
      expect(errorRetryAfterMs(err)).toBe(7_000);
      for (const text of leaks(err)) expect(text).not.toContain(PAT);
    } finally {
      await mock.close();
    }
  });

  it('sanitises a refused connection', async () => {
    const err = await createJiraDataSource(dcCreds('http://127.0.0.1:1'), { retry: noWait })
      .listBoards()
      .catch((e) => e);
    expect(mapJiraError(err).code).toBe('unreachable');
    expect(err.cause).toBeUndefined();
    for (const text of leaks(err)) expect(text).not.toContain(PAT);
  });
});

describe('credentials provider robustness', () => {
  const cloudOk = (): JiraCredentials => ({
    kind: 'cloud_basic',
    baseUrl: '',
    email: 'a',
    apiToken: 'b',
  });

  it('does not cache a rejected provider call', async () => {
    const mock = await startMockJira({
      flavor: 'cloud',
      validAuthorization: `Basic ${Buffer.from('a:b').toString('base64')}`,
      dataset: demoDataset(new Date()),
    });
    try {
      let n = 0;
      const source = createJiraDataSource(
        async () => {
          if (++n === 1) throw new Error('transient');
          return { ...cloudOk(), baseUrl: mock.url };
        },
        { retry: noWait },
      );
      await expect(source.listBoards()).rejects.toThrow('transient');
      expect(await source.listBoards()).toHaveLength(2);
    } finally {
      await mock.close();
    }
  });

  it('re-reads credentials on a 429 retry', async () => {
    const mock = await startMockJira({
      flavor: 'cloud',
      validAuthorization: `Basic ${Buffer.from('a:b').toString('base64')}`,
      dataset: demoDataset(new Date()),
      rateLimitFirst: 1,
    });
    try {
      let n = 0;
      const source = createJiraDataSource(
        async () => {
          n++;
          return { ...cloudOk(), baseUrl: mock.url };
        },
        { retry: noWait },
      );
      await source.listBoards();
      expect(n).toBe(3); // flavour pick + first attempt + retry
    } finally {
      await mock.close();
    }
  });

  it('refuses a credential kind change', async () => {
    const mock = await startMockJira({
      flavor: 'cloud',
      validAuthorization: `Basic ${Buffer.from('a:b').toString('base64')}`,
      dataset: demoDataset(new Date()),
    });
    try {
      let n = 0;
      const source = createJiraDataSource(
        async (): Promise<JiraCredentials> =>
          ++n <= 2 ? { ...cloudOk(), baseUrl: mock.url } : dcCreds(mock.url),
        { retry: noWait },
      );
      await source.listBoards();
      await expect(source.listBoards()).rejects.toThrow('cannot change');
    } finally {
      await mock.close();
    }
  });
});

describe('response size cap', () => {
  const big = JSON.stringify({ values: [], pad: 'x'.repeat(5_000) });

  it('Cloud rejects an oversized body (Content-Length and streamed)', async () => {
    const s = await hostile(
      () => null,
      () => big,
    );
    const source = createJiraDataSource(cloudCreds(s.url), {
      retry: noWait,
      maxResponseBytes: 1_000,
    });
    await expect(source.listBoards()).rejects.toMatchObject({ name: 'ResponseTooLargeError' });

    // No Content-Length (chunked): counted while reading.
    const chunked = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(big.slice(0, 2_000));
      setTimeout(() => res.end(big.slice(2_000)), 10);
    });
    servers.push(chunked);
    await new Promise<void>((r) => chunked.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(chunked.address() as AddressInfo).port}`;
    await expect(
      createJiraDataSource(cloudCreds(url), {
        retry: noWait,
        maxResponseBytes: 1_000,
      }).listBoards(),
    ).rejects.toMatchObject({ name: 'ResponseTooLargeError' });
  });

  it('Data Center rejects an oversized body without leaking the PAT', async () => {
    const s = await hostile(
      () => null,
      () => big,
    );
    const err = await createJiraDataSource(dcCreds(s.url), {
      retry: noWait,
      maxResponseBytes: 1_000,
    })
      .listBoards()
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(inspect(err, { depth: 10, showHidden: true })).not.toContain(PAT);
  });

  it('accepts a body under the cap', async () => {
    const s = await hostile(() => ({ values: [] }));
    expect(await createJiraDataSource(cloudCreds(s.url), { retry: noWait }).listBoards()).toEqual(
      [],
    );
  });
});

describe('OAuth gateway path', () => {
  it('encodes the cloud id', async () => {
    const mock = await startMockJira({
      flavor: 'cloud',
      validAuthorization: 'Bearer t',
      pathPrefix: '/ex/jira/a%2Fb',
      dataset: demoDataset(new Date()),
    });
    try {
      const source = createJiraDataSource(
        {
          kind: 'cloud_oauth',
          baseUrl: 'https://x.atlassian.net',
          cloudId: 'a/b',
          accessToken: 't',
        },
        { atlassianApiBase: new URL(mock.url).origin, retry: noWait },
      );
      expect(await source.listBoards()).toHaveLength(2);
    } finally {
      await mock.close();
    }
  });
});

/**
 * A slow-drip server (the F2 tarpit): headers at once, then one byte of body every 100 ms, for
 * ever. Each byte resets a socket idle timer, so only a total deadline ends the request.
 */
async function tarpit() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"isLast":false,"values":[');
    const drip = setInterval(() => res.write(' '), 100);
    res.on('close', () => clearInterval(drip));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('per-request deadline and the caller’s signal (F2)', () => {
  for (const [flavour, creds] of [
    ['Cloud', cloudCreds],
    ['Data Center', dcCreds],
  ] as const) {
    it(`${flavour}: a body that drips for ever ends at the request deadline`, async () => {
      const source = createJiraDataSource(creds(await tarpit()), {
        timeoutMs: 400,
        retry: noWait,
      });
      const started = Date.now();
      await expect(source.listBoards()).rejects.toBeDefined();
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it(`${flavour}: the caller's signal ends a request in flight`, async () => {
      const ac = new AbortController();
      const source = createJiraDataSource(creds(await tarpit()), {
        timeoutMs: 30_000,
        retry: noWait,
        signal: ac.signal,
      });
      setTimeout(() => ac.abort(), 200);
      const started = Date.now();
      await expect(source.listBoards()).rejects.toBeDefined();
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  }

  it('the caller’s signal ends a Retry-After wait at once (no setTimeout left running)', async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.writeHead(429, { 'retry-after': '60', 'content-type': 'application/json' });
      res.end('{}');
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const creds of [cloudCreds(url), dcCreds(url)]) {
      const ac = new AbortController();
      // The real sleep: the wait must be cut short by the signal, not by an injected no-op.
      const source = createJiraDataSource(creds, { signal: ac.signal });
      setTimeout(() => ac.abort(), 200);
      const started = Date.now();
      await expect(source.listStatuses()).rejects.toBeDefined();
      expect(Date.now() - started).toBeLessThan(2_000);
    }
    expect(hits).toBe(2); // one request each, no retry after the abort
  });
});
