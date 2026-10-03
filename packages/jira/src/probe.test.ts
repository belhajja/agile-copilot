import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { probeJira } from './probe';
import { type MockJira, startMockJira } from './testing/mock-jira-server';

const basic = (email: string, token: string) =>
  `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;

describe('probeJira', () => {
  let mock: MockJira | undefined;
  afterEach(async () => {
    await mock?.close();
    mock = undefined;
  });

  it('accepts valid Cloud basic credentials (REST v3)', async () => {
    mock = await startMockJira({
      flavor: 'cloud',
      validAuthorization: basic('pm@acme.com', 'tok'),
    });
    const r = await probeJira({
      kind: 'cloud_basic',
      baseUrl: mock.url,
      email: 'pm@acme.com',
      apiToken: 'tok',
    });
    expect(r).toEqual({
      ok: true,
      deployment: 'cloud',
      version: '1001.0.0-SNAPSHOT',
      account: { id: 'acc-1', displayName: 'Pat Cloud' },
    });
  });

  it('maps a rejected Cloud token to unauthorized', async () => {
    mock = await startMockJira({
      flavor: 'cloud',
      validAuthorization: basic('pm@acme.com', 'tok'),
    });
    const r = await probeJira({
      kind: 'cloud_basic',
      baseUrl: mock.url,
      email: 'pm@acme.com',
      apiToken: 'bad',
    });
    expect(r).toMatchObject({ ok: false, code: 'unauthorized' });
  });

  it('uses the OAuth gateway with the cloud id', async () => {
    mock = await startMockJira({
      flavor: 'cloud',
      validAuthorization: 'Bearer access-1',
      pathPrefix: '/ex/jira/cloud-123',
    });
    const gateway = new URL(mock.url).origin;
    const r = await probeJira(
      {
        kind: 'cloud_oauth',
        baseUrl: 'https://acme.atlassian.net',
        cloudId: 'cloud-123',
        accessToken: 'access-1',
      },
      { atlassianApiBase: gateway },
    );
    expect(r).toMatchObject({ ok: true, deployment: 'cloud' });
  });

  it('accepts a Data Center PAT (REST v2, bearer) under a context path', async () => {
    mock = await startMockJira({
      flavor: 'datacenter',
      validAuthorization: 'Bearer good-pat',
      pathPrefix: '/jira',
    });
    const r = await probeJira({ kind: 'datacenter_pat', baseUrl: mock.url, token: 'good-pat' });
    expect(r).toEqual({
      ok: true,
      deployment: 'datacenter',
      version: '10.3.0',
      account: { id: 'JIRAUSER1', displayName: 'Pat DC' },
    });
    expect(mock.requests.every((req) => req.path.startsWith('/jira/rest/api/2/'))).toBe(true);
  });

  it('maps a rejected PAT to unauthorized', async () => {
    mock = await startMockJira({ flavor: 'datacenter', validAuthorization: 'Bearer good-pat' });
    expect(
      await probeJira({ kind: 'datacenter_pat', baseUrl: mock.url, token: 'nope' }),
    ).toMatchObject({
      ok: false,
      code: 'unauthorized',
    });
  });

  it('flags a Cloud site entered as Data Center', async () => {
    mock = await startMockJira({ flavor: 'cloud', validAuthorization: 'Bearer good-pat' });
    // DC client calls /rest/api/2 — the cloud mock only serves v3, so it is not recognised as Jira DC.
    const r = await probeJira({ kind: 'datacenter_pat', baseUrl: mock.url, token: 'good-pat' });
    expect(r).toMatchObject({ ok: false, code: 'not_jira' });
  });

  describe('redirects (SSRF)', () => {
    let target: Server | undefined;
    let redirector: Server | undefined;
    afterEach(async () => {
      for (const s of [target, redirector]) {
        if (s) {
          s.closeAllConnections();
          await new Promise((r) => s.close(r));
        }
      }
    });

    const listen = (s: Server) =>
      new Promise<number>((resolve) =>
        s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)),
      );

    async function setup() {
      const hits: string[] = [];
      target = createServer((req, res) => {
        hits.push(req.url ?? '');
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
      const targetPort = await listen(target);
      redirector = createServer((_req, res) => {
        res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/internal` }).end();
      });
      const port = await listen(redirector);
      return { hits, url: `http://127.0.0.1:${port}` };
    }

    it('does not follow redirects for Cloud probes', async () => {
      const { hits, url } = await setup();
      const r = await probeJira({
        kind: 'cloud_basic',
        baseUrl: url,
        email: 'pm@acme.com',
        apiToken: 'tok',
      });
      expect(r).toMatchObject({ ok: false, code: 'not_jira' });
      expect(hits).toEqual([]);
    });

    it('does not follow redirects for Data Center probes', async () => {
      const { hits, url } = await setup();
      const r = await probeJira({ kind: 'datacenter_pat', baseUrl: url, token: 't' });
      expect(r).toMatchObject({ ok: false, code: 'not_jira' });
      expect(hits).toEqual([]);
    });
  });

  it('maps a closed port to unreachable', async () => {
    const r = await probeJira(
      { kind: 'datacenter_pat', baseUrl: 'http://127.0.0.1:9', token: 't' },
      { timeoutMs: 3_000 },
    );
    expect(r).toMatchObject({ ok: false, code: 'unreachable' });
  });
});
