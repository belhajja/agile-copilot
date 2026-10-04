import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { runMigrations } from './migrate';

/**
 * P5-R38: managed Postgres (RDS, Cloud SQL, …) rarely lets the migration role be a superuser or
 * have BYPASSRLS, and FORCE RLS applies to table owners. `user_org_ids` must still find every
 * workspace a person has rows in when the migrations ran as such a role.
 */
describe('user_org_ids under a restricted owner (no superuser, no BYPASSRLS)', () => {
  let container: StartedPostgreSqlContainer;
  let app: ReturnType<typeof createDb>;
  let admin: ReturnType<typeof postgres>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    const su = postgres(container.getConnectionUri(), { max: 1 });
    await su.unsafe(`
      CREATE ROLE app_user LOGIN PASSWORD 'app_pw';
      CREATE ROLE migrator LOGIN PASSWORD 'mig_pw' NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
      GRANT app_user TO migrator;
    `);
    await su.unsafe('CREATE DATABASE restricted OWNER migrator');
    await su.end();
    const url = (user: string, password: string) => {
      const u = new URL(container.getConnectionUri());
      u.username = user;
      u.password = password;
      u.pathname = '/restricted';
      return u.toString();
    };
    const su2 = postgres(url(container.getUsername(), container.getPassword()), { max: 1 });
    await su2.unsafe('GRANT USAGE ON SCHEMA public TO app_user');
    await su2.end();
    await runMigrations(url('migrator', 'mig_pw'));
    app = createDb(url('app_user', 'app_pw'), { max: 1 });
    // Seeded by the superuser (bypasses RLS): two workspaces, data in one of them only.
    admin = postgres(url(container.getUsername(), container.getPassword()), { max: 1 });
    await admin.unsafe(`
      INSERT INTO organization (id, name, slug, created_at) VALUES
        ('org_a', 'A', 'a', now()), ('org_b', 'B', 'b', now()), ('org_c', 'C', 'c', now());
      INSERT INTO agent_conversations (org_id, user_id, title) VALUES ('org_b', 'u_left', 't');
      INSERT INTO audit_log (org_id, actor_user_id, action) VALUES ('org_c', 'u_left', 'x');
      INSERT INTO agent_conversations (org_id, user_id, title) VALUES ('org_a', 'u_other', 't');
    `);
  });
  afterAll(async () => {
    await app?.close();
    await admin?.end();
    await container?.stop();
  });

  it('really runs as a restricted owner', async () => {
    const [role] =
      await admin`select rolsuper, rolbypassrls from pg_roles where rolname = 'migrator'`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const [fn] = await admin`
      select pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer
      from pg_proc p where p.proname = 'user_org_ids'`;
    expect(fn).toEqual({ owner: 'migrator', definer: true });
  });

  it('finds the workspaces a person has rows in, and nothing for a stranger', async () => {
    const ids = async (userId: string) =>
      (
        (await app.db.execute(sql`select id from user_org_ids(${userId}) as id`)) as unknown as {
          id: string;
        }[]
      ).map((r) => r.id);
    expect(await ids('u_left')).toEqual(['org_b', 'org_c']);
    expect(await ids('u_other')).toEqual(['org_a']);
    expect(await ids('u_stranger')).toEqual([]);
  });

  it("leaves the caller's workspace context as it was", async () => {
    const after = await app.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', 'org_a', true)`);
      await tx.execute(sql`select id from user_org_ids('u_left') as id`);
      const [row] = (await tx.execute(
        sql`select current_setting('app.current_org_id', true) as org`,
      )) as unknown as { org: string }[];
      return row?.org;
    });
    expect(after).toBe('org_a');
  });
});
