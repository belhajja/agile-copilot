import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { migrationsFolder } from './migrate';
import { startTestDatabase, type TestDatabase } from './testing';

/** A migration's statements, found by name (its number depends on the migrations before it). */
function statementsOf(suffix: string): string[] {
  const file = readdirSync(migrationsFolder).find((f) => f.endsWith(suffix));
  return readFileSync(join(migrationsFolder, file ?? 'missing.sql'), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
}

const ROLE_MIGRATION = statementsOf('_phase5_roles.sql');
const ROLE_CHECK_MIGRATION = statementsOf('_phase5_role_check.sql');

const pgError = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (error) {
    const e = ((error as { cause?: unknown }).cause ?? error) as {
      code?: string;
      constraint_name?: string;
    };
    return { code: e.code, constraint: e.constraint_name };
  }
};

describe('Phase 5 roles in the schema', () => {
  let tdb: TestDatabase;
  let owner: ReturnType<typeof createDb>;
  const rows = async (q: ReturnType<typeof sql>) =>
    (await owner.db.execute(q)) as unknown as { id: string; role: string }[];

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = createDb(tdb.ownerUrl, { max: 1 });
  });
  afterAll(async () => {
    await owner?.close();
    await tdb?.stop();
  });

  it('refuses any member role but the four, and any pending invitation role but the four', async () => {
    await owner.db.execute(sql`
      insert into "user" (id, name, email) values
        ('g1', 'A', 'g1@example.com'), ('g2', 'B', 'g2@example.com'),
        ('g3', 'C', 'g3@example.com'), ('g4', 'D', 'g4@example.com'),
        ('g5', 'E', 'g5@example.com')`);
    await owner.db.execute(sql`
      insert into organization (id, name, slug, created_at) values ('og', 'G', 'g', now())`);
    await owner.db.execute(sql`
      insert into member (id, organization_id, user_id, role, created_at) values
        ('g1', 'og', 'g1', 'owner', now()), ('g2', 'og', 'g2', 'admin', now()),
        ('g3', 'og', 'g3', 'manager', now()), ('g4', 'og', 'g4', 'viewer', now())`);

    for (const role of ['member', ' owner', 'owner ', 'admin,member', 'superuser', '']) {
      expect(
        await pgError(
          owner.db.execute(sql`
            insert into member (id, organization_id, user_id, role, created_at)
            values ('g5', 'og', 'g5', ${role}, now())`),
        ),
      ).toEqual({ code: '23514', constraint: 'member_role_check' });
    }
    // The generated column default (`member`) is refused too.
    expect(
      await pgError(
        owner.db.execute(sql`
          insert into member (id, organization_id, user_id, created_at)
          values ('g5', 'og', 'g5', now())`),
      ),
    ).toEqual({ code: '23514', constraint: 'member_role_check' });

    expect(
      await pgError(
        owner.db.execute(sql`
          insert into invitation (id, organization_id, email, role, status, expires_at, inviter_id)
          values ('gi1', 'og', 'x@example.com', 'member', 'pending', now(), 'g1')`),
      ),
    ).toEqual({ code: '23514', constraint: 'invitation_role_check' });
    // Settled invitations are history and keep whatever role they had.
    await owner.db.execute(sql`
      insert into invitation (id, organization_id, email, role, status, expires_at, inviter_id)
      values ('gi2', 'og', 'y@example.com', 'member', 'accepted', now(), 'g1'),
             ('gi3', 'og', 'z@example.com', 'viewer', 'pending', now(), 'g1')`);
    // A settled invitation cannot be reopened with a legacy role.
    expect(
      await pgError(
        owner.db.execute(sql`update invitation set status = 'pending' where id = 'gi2'`),
      ),
    ).toEqual({ code: '23514', constraint: 'invitation_role_check' });
  });

  it('rewrites legacy, list and malformed roles to the strongest exact role, granting nothing new', async () => {
    // The database as it was before the Phase 5 migrations.
    await owner.db.execute(sql`alter table member drop constraint member_role_check`);
    await owner.db.execute(sql`alter table invitation drop constraint invitation_role_check`);
    const legacy: [string, string, string][] = [
      ['m01', 'owner', 'owner'],
      ['m02', 'member', 'viewer'],
      ['m03', 'admin', 'admin'],
      ['m04', 'admin,member', 'admin'],
      ['m05', 'member,owner', 'owner'],
      // Not an owner to better-auth (it compares untrimmed): never promoted by the rewrite.
      ['m06', ' owner', 'viewer'],
      ['m07', 'admin, owner', 'admin'],
      ['m08', 'superuser', 'viewer'],
      ['m09', 'manager', 'manager'],
      ['m10', 'viewer,manager', 'manager'],
    ];
    for (const [id, role] of legacy) {
      await owner.db.execute(sql`
        insert into "user" (id, name, email) values (${id}, 'U', ${`${id}@example.com`})`);
      await owner.db.execute(sql`
        insert into organization (id, name, slug, created_at)
        values (${`o${id}`}, 'O', ${`s${id}`}, now())`);
      await owner.db.execute(sql`
        insert into member (id, organization_id, user_id, role, created_at)
        values (${id}, ${`o${id}`}, ${id}, ${role}, now())`);
    }
    await owner.db.execute(sql`
      insert into invitation (id, organization_id, email, role, status, expires_at, inviter_id)
      values ('i1', 'om01', 'd@example.com', 'member', 'pending', now() + interval '1 day', 'm01'),
             ('i2', 'om01', 'e@example.com', 'member', 'accepted', now(), 'm01'),
             ('i3', 'om01', 'f@example.com', 'admin,member', 'pending', now(), 'm01'),
             ('i4', 'om01', 'g@example.com', ' owner', 'pending', now(), 'm01'),
             ('i5', 'om01', 'h@example.com', 'admin,owner', 'canceled', now(), 'm01')`);

    for (const statement of [...ROLE_MIGRATION, ...ROLE_CHECK_MIGRATION]) {
      await owner.db.execute(sql.raw(statement));
    }

    expect(await rows(sql`select id, role from member where id like 'm%' order by id`)).toEqual(
      legacy.map(([id, , role]) => ({ id, role })),
    );
    expect(await rows(sql`select id, role from invitation where id like 'i%' order by id`)).toEqual(
      [
        { id: 'i1', role: 'viewer' },
        { id: 'i2', role: 'member' },
        { id: 'i3', role: 'admin' },
        { id: 'i4', role: 'viewer' },
        { id: 'i5', role: 'admin,owner' },
      ],
    );
    // The constraints are back.
    expect(
      await pgError(owner.db.execute(sql`update member set role = 'member' where id = 'm01'`)),
    ).toEqual({ code: '23514', constraint: 'member_role_check' });
  });
});
