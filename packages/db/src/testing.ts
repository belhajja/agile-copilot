import { PostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { runMigrations } from './migrate';

export interface TestDatabase {
  ownerUrl: string;
  appUrl: string;
  stop(): Promise<void>;
}

const APP_PASSWORD = 'app_user_test_password';

/** Fresh Postgres 17 with the app_user role and all migrations applied. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const ownerUrl = container.getConnectionUri();
  const admin = postgres(ownerUrl, { max: 1 });
  await admin.unsafe(
    `CREATE ROLE app_user LOGIN PASSWORD '${APP_PASSWORD}'; GRANT USAGE ON SCHEMA public TO app_user;`,
  );
  await admin.end();
  await runMigrations(ownerUrl);
  const app = new URL(ownerUrl);
  app.username = 'app_user';
  app.password = APP_PASSWORD;
  return { ownerUrl, appUrl: app.toString(), stop: async () => void (await container.stop()) };
}
