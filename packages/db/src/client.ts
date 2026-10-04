import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export function createDb(url: string, opts: { max?: number } = {}) {
  const client = postgres(url, { max: opts.max ?? 10 });
  const db = drizzle(client, { schema });
  return { db, close: () => client.end() };
}

export type Db = ReturnType<typeof createDb>['db'];
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Runs fn in a transaction scoped to one tenant; RLS hides every other org's rows. */
export function withOrg<T>(db: Db, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!orgId) throw new Error('withOrg requires a non-empty orgId');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/** Postgres unique_violation, whether thrown directly or wrapped by drizzle (DrizzleQueryError.cause). */
export function isUniqueViolation(e: unknown): boolean {
  for (let cur: unknown = e; cur; cur = (cur as { cause?: unknown }).cause) {
    if ((cur as { code?: unknown }).code === '23505') return true;
  }
  return false;
}
