import { connect } from 'node:net';
import { runMigrations } from '@agile/db';

/** Whether something accepts TCP connections on 127.0.0.1:`port` (within 2 s). */
const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2_000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });

export default async function globalSetup() {
  await runMigrations(
    process.env.DATABASE_OWNER_URL ?? 'postgres://agile:agile_dev_password@localhost:5433/agile',
  );
  // Playwright only waits for 4010. Locally it may reuse a `pnpm mocks` started before the
  // mcp-atlassian doubles (4050, read-only twin under /readonly), the SMTP mock (4070) or the
  // webhook receiver (4080) or the OIDC provider (4090) existed; fail early and clearly instead of
  // in the tests.
  const missing: string[] = [];
  if (!(await listening(4050))) missing.push('mcp-atlassian double (4050)');
  else {
    // An older mocks process proxies /readonly/mcp to the read-write double, which answers 404.
    // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- local test double
    const twin = await fetch('http://127.0.0.1:4050/readonly/mcp').catch(() => null);
    if (!twin || twin.status === 404) missing.push('read-only mcp-atlassian twin (4050/readonly)');
  }
  if (!(await listening(4070))) missing.push('SMTP mock (4070)');
  if (!(await listening(4080))) missing.push('webhook mock (4080)');
  if (!(await listening(4090))) missing.push('OIDC mock (4090)');
  if (missing.length > 0) {
    throw new Error(
      `Not listening: ${missing.join(', ')}. Stop the old \`pnpm mocks\` process (port 4010) and run the e2e suite again.`,
    );
  }
}
