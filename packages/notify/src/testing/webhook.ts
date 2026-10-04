import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface CapturedPost {
  path: string;
  body: unknown;
}

/**
 * A stand-in for Slack/Teams incoming webhooks: records every POST. `/fail` (and any path added
 * to `failing`) answers 500, `/redirect` 302 and `/slow` never answers (for timeouts); any other
 * path answers 200 "ok". Listens on a random port unless `port` (the e2e mocks process).
 */
export async function startMockWebhook(opts: { port?: number } = {}) {
  const posts: CapturedPost[] = [];
  const failing = new Set<string>(['/fail']);
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const path = req.url ?? '';
      if (path === '/slow') return;
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // keep the raw text
      }
      posts.push({ path, body });
      if (failing.has(path)) res.writeHead(500).end('error');
      else if (path === '/redirect')
        res.writeHead(302, { location: 'http://169.254.169.254/' }).end();
      else res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    posts,
    failing,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export type MockWebhook = Awaited<ReturnType<typeof startMockWebhook>>;
