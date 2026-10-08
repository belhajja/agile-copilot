import { createServer, get, type Server } from 'node:http';
import { get as httpsGet } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RedirectBlockedError } from './http';
import { checkOutboundUrl, type Resolver } from './outbound-url';
import {
  BlockedAddressError,
  createOutboundFetch,
  createPinnedAgents,
  InsecureTransportError,
  isBlockedAddressError,
  isInsecureTransportError,
  outboundDispatcher,
} from './pinned';

/** Answers the first call with a public address, every later call with the local server. */
const rebinding = (): Resolver => {
  let calls = 0;
  return async () => (calls++ === 0 ? ['93.184.216.34'] : ['127.0.0.1']);
};

describe('DNS-pinned outbound requests', () => {
  const hits: { url: string; host?: string }[] = [];
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push({ url: req.url ?? '', host: req.headers.host });
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/ok' }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  afterEach(() => {
    hits.length = 0;
  });

  it('connects to the address it validated and keeps the hostname', async () => {
    const fetch = createOutboundFetch({
      allowedPrivateHosts: ['jira.corp.test'],
      resolve: async () => ['127.0.0.1'],
    });
    const res = await fetch(`http://jira.corp.test:${port}/ok`);
    expect(await res.json()).toEqual({ ok: true });
    expect(hits).toEqual([{ url: '/ok', host: `jira.corp.test:${port}` }]);
  });

  it('refuses a host that rebinds to a private address after the URL check', async () => {
    const resolve = rebinding();
    const url = `https://rebind.example:${port}/ok`;
    expect((await checkOutboundUrl(url, { allowedPrivateHosts: [], resolve })).ok).toBe(true);
    const fetch = createOutboundFetch({ allowedPrivateHosts: [], resolve });
    const err = await fetch(url).catch((e: unknown) => e);
    expect(isBlockedAddressError(err)).toBe(true);
    expect(hits).toEqual([]);
  });

  it('refuses private IP literals that are not allowlisted, without connecting', async () => {
    const fetch = createOutboundFetch({ allowedPrivateHosts: [] });
    await expect(fetch(`http://127.0.0.1:${port}/ok`)).rejects.toBeInstanceOf(BlockedAddressError);
    expect(hits).toEqual([]);
  });

  it('allows allowlisted IP literals', async () => {
    const fetch = createOutboundFetch({ allowedPrivateHosts: ['127.0.0.1'] });
    expect((await fetch(`http://127.0.0.1:${port}/ok`)).status).toBe(200);
  });

  it('still refuses redirects', async () => {
    const fetch = createOutboundFetch({ allowedPrivateHosts: ['127.0.0.1'] });
    await expect(fetch(`http://127.0.0.1:${port}/redirect`)).rejects.toBeInstanceOf(
      RedirectBlockedError,
    );
    expect(hits.map((h) => h.url)).toEqual(['/redirect']);
  });

  it('pins Node http agents too (axios / jira.js v5)', async () => {
    const policy = (allowedPrivateHosts: string[]) => ({
      allowedPrivateHosts,
      resolve: async () => ['127.0.0.1'],
    });
    const blocked = await new Promise<unknown>((resolve) => {
      const { httpsAgent } = createPinnedAgents(policy([]));
      httpsGet({ host: 'evil.example', port, path: '/ok', agent: httpsAgent }, resolve).on(
        'error',
        resolve,
      );
    });
    expect(isBlockedAddressError(blocked)).toBe(true);
    expect(hits).toEqual([]);
    const status = await new Promise<number | unknown>((resolve) => {
      const { httpAgent } = createPinnedAgents(policy(['corp.test']));
      get({ host: 'jira.corp.test', port, path: '/ok', agent: httpAgent }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', resolve);
    });
    expect(status).toBe(200);
  });

  it('refuses plain http to a public host through the Node agents', async () => {
    const err = await new Promise<unknown>((resolve) => {
      const { httpAgent } = createPinnedAgents({
        allowedPrivateHosts: [],
        resolve: async () => ['93.184.216.34'],
      });
      get({ host: 'jira.example.com', port, path: '/ok', agent: httpAgent }, resolve).on(
        'error',
        resolve,
      );
    });
    expect(isInsecureTransportError(err)).toBe(true);
  });

  it('refuses plain http to a public host before sending anything', async () => {
    const fetch = createOutboundFetch({
      allowedPrivateHosts: [],
      resolve: async () => ['93.184.216.34'],
    });
    await expect(
      fetch(`http://api.example.com:${port}/ok`, { headers: { authorization: 'Bearer x' } }),
    ).rejects.toBeInstanceOf(InsecureTransportError);
    await expect(fetch(`http://93.184.216.34:${port}/ok`)).rejects.toBeInstanceOf(
      InsecureTransportError,
    );
    expect(hits).toEqual([]);
  });

  it('reports plain http to a private, non-allowlisted host as blocked', async () => {
    const fetch = createOutboundFetch({
      allowedPrivateHosts: [],
      resolve: async () => ['10.0.0.5'],
    });
    const err = await fetch(`http://jira.corp.test:${port}/ok`).catch((e: unknown) => e);
    expect(isBlockedAddressError(err)).toBe(true);
  });

  it('refuses IP literals through the Node agents unless allowlisted', async () => {
    const request = (allowedPrivateHosts: string[]) =>
      new Promise<number | unknown>((resolve) => {
        const { httpAgent } = createPinnedAgents({ allowedPrivateHosts });
        get({ host: '127.0.0.1', port, path: '/ok', agent: httpAgent }, (res) => {
          res.resume();
          resolve(res.statusCode);
        }).on('error', resolve);
      });
    expect(isBlockedAddressError(await request([]))).toBe(true);
    expect(hits).toEqual([]);
    expect(await request(['127.0.0.1'])).toBe(200);
  });

  it('refuses cloud metadata hosts even when allowlisted', async () => {
    const fetch = createOutboundFetch({
      allowedPrivateHosts: ['metadata.google.internal'],
      resolve: async () => ['127.0.0.1'],
    });
    const err = await fetch(`http://metadata.google.internal:${port}/ok`).catch((e: unknown) => e);
    expect(isBlockedAddressError(err)).toBe(true);
    expect(hits).toEqual([]);
  });

  it('matches the allowlist ignoring a trailing dot', async () => {
    const fetch = createOutboundFetch({
      allowedPrivateHosts: ['corp.test'],
      resolve: async () => ['127.0.0.1'],
    });
    expect((await fetch(`http://jira.corp.test.:${port}/ok`)).status).toBe(200);
    const blocked = createOutboundFetch({
      allowedPrivateHosts: [],
      resolve: async () => ['127.0.0.1'],
    });
    const err = await blocked(`http://jira.corp.test.:${port}/ok`).catch((e: unknown) => e);
    expect(isBlockedAddressError(err)).toBe(true);
  });

  it('shares one dispatcher per policy: repeated clients leave no idle sockets behind', async () => {
    const resolve: Resolver = async () => ['127.0.0.1'];
    const policy = () => ({ allowedPrivateHosts: ['corp.test', 'Jira.Corp.Test.'], resolve });
    expect(outboundDispatcher(policy())).toBe(
      outboundDispatcher({ allowedPrivateHosts: ['jira.corp.test', 'corp.test'], resolve }),
    );
    expect(outboundDispatcher(policy())).not.toBe(
      outboundDispatcher({ ...policy(), resolve: undefined }),
    );
    expect(outboundDispatcher(policy())).not.toBe(
      outboundDispatcher({ allowedPrivateHosts: ['corp.test'], resolve }),
    );
    const sockets = () =>
      process.getActiveResourcesInfo().filter((r) => r === 'TCPSocketWrap').length;
    // One request per client, as the agent makes one client per Jira tool call or chat turn.
    const once = async () => {
      const res = await createOutboundFetch(policy())(`http://jira.corp.test:${port}/ok`);
      await res.text();
    };
    await once();
    const before = sockets();
    for (let i = 0; i < 20; i++) await once();
    expect(sockets() - before).toBeLessThanOrEqual(1);
  });
});
