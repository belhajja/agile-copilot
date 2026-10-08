import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestProject } from 'vitest/node';
import { startTestServer, TEST_POSTGRES_BROKER, type TestServer } from './testing';

/**
 * One Postgres container for the whole run, started on the first `startTestDatabase()` call so
 * runs without database tests need no Docker. Test files reach it through a small local HTTP
 * endpoint and each gets a database copied from the migrated template.
 */
export default async function setup(project: TestProject) {
  let server: ReturnType<typeof startTestServer> | undefined;
  const http = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    server ??= startTestServer();
    server.then(
      ({ adminUrl, template }) => {
        const body: TestServer = { adminUrl, template };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      },
      (err: unknown) => res.writeHead(500).end(String(err)),
    );
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  project.provide(TEST_POSTGRES_BROKER as never, `http://127.0.0.1:${port}/` as never);

  return async () => {
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
    const started = await server?.catch(() => undefined);
    await started?.stop();
  };
}
