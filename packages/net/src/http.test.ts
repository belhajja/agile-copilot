import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DeadlineExceededError, fetchNoRedirect, RedirectBlockedError, withDeadline } from './http';

describe('fetchNoRedirect', () => {
  const hits: string[] = [];
  let server: Server;
  let base = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/redirect') {
        res.writeHead(302, { location: `${base}/target` }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  afterEach(() => {
    hits.length = 0;
  });

  it('returns non-redirect responses untouched', async () => {
    const res = await fetchNoRedirect(`${base}/ok`);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('refuses a redirect without contacting its target', async () => {
    const err = await fetchNoRedirect(`${base}/redirect`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedirectBlockedError);
    expect(err).toMatchObject({ name: 'RedirectBlockedError', status: 302 });
    expect((err as Error).message).toMatch(/302/);
    expect(hits).toEqual(['/redirect']);
  });

  it('ignores a caller asking to follow redirects', async () => {
    await expect(fetchNoRedirect(`${base}/redirect`, { redirect: 'follow' })).rejects.toThrow(
      RedirectBlockedError,
    );
    expect(hits).toEqual(['/redirect']);
  });
});

describe('withDeadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the value and clears its timer', async () => {
    vi.useFakeTimers();
    await expect(withDeadline(Promise.resolve(42), 1_000)).resolves.toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its timer when the promise rejects', async () => {
    vi.useFakeTimers();
    await expect(withDeadline(Promise.reject(new Error('boom')), 1_000)).rejects.toThrow('boom');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with a TimeoutError once the deadline passes', async () => {
    vi.useFakeTimers();
    const pending = withDeadline(new Promise<never>(() => {}), 1_000);
    const assertion = expect(pending).rejects.toBeInstanceOf(DeadlineExceededError);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('uses the caller-supplied error', async () => {
    class Custom extends Error {}
    await expect(
      withDeadline(new Promise<never>(() => {}), 5, () => new Custom()),
    ).rejects.toBeInstanceOf(Custom);
  });
});
