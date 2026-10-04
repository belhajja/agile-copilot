import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { migrationsFolder } from './migrate';
import { startTestDatabase, type TestDatabase } from './testing';

/** The Phase 5 role migration (found by name: its number depends on the migrations before it). */
const ROLE_MIGRATION_FILE = readdirSync(migrationsFolder).find((f) =>
  f.endsWith('_phase5_roles.sql'),
);
const ROLE_MIGRATION = readFileSync(
  join(migrationsFolder, ROLE_MIGRATION_FILE ?? 'missing.sql'),
  'utf8',
)
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter(Boolean);

describe('Phase 5 role migration', () => {
  let tdb: TestDatabase;
  let owner: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = createDb(tdb.ownerUrl, { max: 1 });
  });
  afterAll(async () => {
    await owner?.close();
    await tdb?.stop();
  });

  it('turns every member into a viewer and keeps every other role', async () => {
    await owner.db.execute(sql`
      insert into "user" (id, name, email) values
        ('u1', 'A', 'a@example.com'), ('u2', 'B', 'b@example.com'), ('u3', 'C', 'c@example.com')`);
    await owner.db.execute(sql`
      insert into organization (id, name, slug, created_at) values ('o1', 'Acme', 'acme', now())`);
    await owner.db.execute(sql`
      insert into member (id, organization_id, user_id, role, created_at) values
        ('m1', 'o1', 'u1', 'owner', now()), ('m2', 'o1', 'u2', 'member', now()),
        ('m3', 'o1', 'u3', 'admin', now())`);
    await owner.db.execute(sql`
      insert into invitation (id, organization_id, email, role, status, expires_at, inviter_id)
      values ('i1', 'o1', 'd@example.com', 'member', 'pending', now() + interval '1 day', 'u1'),
             ('i2', 'o1', 'e@example.com', 'member', 'accepted', now(), 'u1')`);

    for (const statement of ROLE_MIGRATION) await owner.db.execute(sql.raw(statement));

    const members = (await owner.db.execute(
      sql`select id, role from member order by id`,
    )) as unknown as { id: string; role: string }[];
    expect(members).toEqual([
      { id: 'm1', role: 'owner' },
      { id: 'm2', role: 'viewer' },
      { id: 'm3', role: 'admin' },
    ]);
    const invitations = (await owner.db.execute(
      sql`select id, role from invitation order by id`,
    )) as unknown as { id: string; role: string }[];
    // Only pending invitations change; accepted ones are history.
    expect(invitations).toEqual([
      { id: 'i1', role: 'viewer' },
      { id: 'i2', role: 'member' },
    ]);
  });
});
