import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * GET /health → 200 when `check` passes, 503 otherwise (for Docker/Kubernetes probes and e2e).
 * The body is only a status word: no versions, config or error details.
 */
export async function startHealthServer(
  port: number,
  host: string,
  check: () => Promise<boolean>,
): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer(async (req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    const ok = await check().catch(() => false);
    res
      .writeHead(ok ? 200 : 503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      })
      .end(
        req.method === 'HEAD' ? undefined : JSON.stringify({ status: ok ? 'ok' : 'unavailable' }),
      );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
