import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { runMigrations } from './migrate';

export interface TestDatabase {
  ownerUrl: string;
  appUrl: string;
  stop(): Promise<void>;
}

/** A Postgres server holding a fully migrated template database. */
export interface TestServer {
  /** Superuser URL of the server's maintenance database (never the template). */
  adminUrl: string;
  template: string;
}

const APP_PASSWORD = 'app_user_test_password';
const TEMPLATE = 'agile_template';

/** Key of the broker URL provided by the root Vitest globalSetup (`vitest-global-setup.ts`). */
export const TEST_POSTGRES_BROKER = 'agileTestPostgresBroker';

/**
 * Postgres 17 tuned for tests (no fsync, data on tmpfs) with the app_user role and a template
 * database that has every migration applied.
 */
export async function startTestServer(): Promise<TestServer & { stop(): Promise<void> }> {
  const container = await new PostgreSqlContainer('postgres:17-alpine')
    .withCommand([
      'postgres',
      ...['-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off'],
      ...['-c', 'max_connections=500'],
    ])
    .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
    .start();
  const adminUrl = container.getConnectionUri();
  const admin = postgres(adminUrl, { max: 1 });
  try {
    await admin.unsafe(`CREATE ROLE app_user LOGIN PASSWORD '${APP_PASSWORD}'`);
    await admin.unsafe(`CREATE DATABASE ${TEMPLATE}`);
  } finally {
    await admin.end();
  }
  const templateUrl = withDatabase(adminUrl, TEMPLATE);
  await grantSchemaUsage(templateUrl);
  await runMigrations(templateUrl);
  return { adminUrl, template: TEMPLATE, stop: async () => void (await container.stop()) };
}

/**
 * A database of its own on `server`: a copy of the migrated template, or an empty database
 * migrated from `migrationsFolder` (to start from an older schema).
 */
export async function createTestDatabase(
  server: TestServer,
  opts: { migrationsFolder?: string } = {},
): Promise<TestDatabase> {
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(server.adminUrl, { max: 1, onnotice: () => {} });
  try {
    const source = opts.migrationsFolder ? 'template0' : server.template;
    for (let attempt = 0; ; attempt++) {
      try {
        await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${source}`);
        break;
      } catch (err) {
        // 55006: another session briefly holds the template (e.g. a concurrent copy).
        if ((err as { code?: string }).code !== '55006' || attempt >= 20) throw err;
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      }
    }
  } finally {
    await admin.end();
  }
  const ownerUrl = withDatabase(server.adminUrl, name);
  if (opts.migrationsFolder) {
    await grantSchemaUsage(ownerUrl);
    await runMigrations(ownerUrl, opts.migrationsFolder);
  }
  const app = new URL(ownerUrl);
  app.username = 'app_user';
  app.password = APP_PASSWORD;
  return {
    ownerUrl,
    appUrl: app.toString(),
    stop: async () => {
      const drop = postgres(server.adminUrl, { max: 1, onnotice: () => {} });
      try {
        await drop.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await drop.end();
      }
    },
  };
}

/**
 * Fresh database with the app_user role and all migrations applied (or those of
 * `migrationsFolder`, to start from an older schema). Under the root Vitest config it is a copy
 * of a template on the Postgres server shared by the run; elsewhere (a single package's config,
 * the evals) it gets a container of its own.
 */
export async function startTestDatabase(
  opts: { migrationsFolder?: string } = {},
): Promise<TestDatabase> {
  const broker = await brokerUrl();
  if (broker) return createTestDatabase(await askBroker(broker), opts);
  const server = await startTestServer();
  try {
    const db = await createTestDatabase(server, opts);
    return { ...db, stop: async () => void (await server.stop()) };
  } catch (err) {
    await server.stop();
    throw err;
  }
}

async function brokerUrl(): Promise<string | undefined> {
  if (!process.env.VITEST) return undefined;
  const { inject } = await import('vitest');
  return (inject as (key: string) => string | undefined)(TEST_POSTGRES_BROKER);
}

/** The broker starts the shared server on the first request (node:http, as tests may stub fetch). */
function askBroker(url: string): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode === 200) resolve(JSON.parse(body) as TestServer);
        else reject(new Error(`shared test Postgres unavailable: ${body}`));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

async function grantSchemaUsage(url: string): Promise<void> {
  const sql = postgres(url, { max: 1 });
  try {
    await sql.unsafe('GRANT USAGE ON SCHEMA public TO app_user');
  } finally {
    await sql.end();
  }
}
