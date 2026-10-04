import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Tx, withOrg } from './client';
import { purgeOrgTenantRows } from './purge';
import {
  deliveryChannels,
  llmConnections,
  skillBuilderCalls,
  skillRuns,
  skills,
  skillVersions,
} from './schema';
import { startTestDatabase, type TestDatabase } from './testing';

const PHASE4_TABLES = [
  'delivery_channels',
  'skill_builder_calls',
  'skill_runs',
  'skill_versions',
  'skills',
];

const skillRow = (orgId: string, name = 'sprint-digest') => ({
  orgId,
  ownerUserId: 'user_1',
  name,
  description: 'Weekly digest',
  trigger: 'schedule' as const,
  output: 'email' as const,
});

/** One row in every Phase 4 table. */
async function seed(tx: Tx, orgId: string) {
  const [skill] = await tx.insert(skills).values(skillRow(orgId)).returning();
  if (!skill) throw new Error('seed failed');
  await tx.insert(skillVersions).values({
    orgId,
    skillId: skill.id,
    version: 1,
    document: '---\nname: sprint-digest\n---\nx',
    createdBy: 'user_1',
  });
  await tx.insert(skillRuns).values({
    orgId,
    skillId: skill.id,
    version: 1,
    trigger: 'schedule',
    scheduledFor: new Date('2026-10-05T08:00:00Z'),
  });
  await tx.insert(deliveryChannels).values({
    id: randomUUID(),
    orgId,
    kind: 'slack',
    name: 'Team channel',
    hint: 'hooks.slack.com',
    secret: 's1.x.y.z',
    createdBy: 'user_1',
  });
  await tx.insert(skillBuilderCalls).values({ orgId, userId: 'user_1' });
  return skill.id;
}

const pgError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    const e = ((error as { cause?: unknown }).cause ?? error) as {
      code?: string;
      constraint_name?: string;
    };
    return { code: e.code, constraint: e.constraint_name };
  }
  return 'no error';
};

describe('Phase 4 tenant tables (as app_user)', () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createDb>;
  let owner: ReturnType<typeof createDb>;
  let skillA = '';

  const countAll = async (orgId: string) => {
    const counts: Record<string, number> = {};
    for (const table of PHASE4_TABLES) {
      const [row] = (await owner.db.execute(
        sql`select count(*)::int as n from ${sql.identifier(table)} where org_id = ${orgId}`,
      )) as unknown as { n: number }[];
      counts[table] = row?.n ?? -1;
    }
    return counts;
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = createDb(tdb.appUrl, { max: 1 });
    owner = createDb(tdb.ownerUrl, { max: 1 });
    skillA = await withOrg(app.db, 'org_a', (tx) => seed(tx, 'org_a'));
    await withOrg(app.db, 'org_b', (tx) => seed(tx, 'org_b'));
  });
  afterAll(async () => {
    await app?.close();
    await owner?.close();
    await tdb?.stop();
  });

  it('isolates every Phase 4 table by org', async () => {
    for (const table of PHASE4_TABLES) {
      const rows = (await withOrg(app.db, 'org_a', (tx) =>
        tx.execute(sql`select org_id from ${sql.identifier(table)}`),
      )) as unknown as { org_id: string }[];
      expect({ table, orgs: [...new Set(rows.map((r) => r.org_id))] }).toEqual({
        table,
        orgs: ['org_a'],
      });
    }
  });

  it('keeps skill names unique per owner, versions unique per skill', async () => {
    expect(
      await pgError(withOrg(app.db, 'org_a', (tx) => tx.insert(skills).values(skillRow('org_a')))),
    ).toEqual({ code: '23505', constraint: 'skills_owner_name_uq' });
    expect(
      await pgError(
        withOrg(app.db, 'org_a', (tx) =>
          tx.insert(skillVersions).values({
            orgId: 'org_a',
            skillId: skillA,
            version: 1,
            document: 'x',
            createdBy: 'user_1',
          }),
        ),
      ),
    ).toEqual({ code: '23505', constraint: 'skill_versions_skill_version_uq' });
    // Another owner may use the same name.
    await withOrg(app.db, 'org_a', async (tx) => {
      const [other] = await tx
        .insert(skills)
        .values({ ...skillRow('org_a'), ownerUserId: 'user_2' })
        .returning();
      expect(other?.name).toBe('sprint-digest');
      expect(other?.ownerUserId).toBe('user_2');
      if (!other) throw new Error('insert failed');
      await tx.delete(skills).where(eq(skills.id, other.id));
    });
  });

  it('runs each scheduled time of a skill once; manual runs are not limited', async () => {
    expect(
      await pgError(
        withOrg(app.db, 'org_a', (tx) =>
          tx.insert(skillRuns).values({
            orgId: 'org_a',
            skillId: skillA,
            version: 1,
            trigger: 'schedule',
            scheduledFor: new Date('2026-10-05T08:00:00Z'),
          }),
        ),
      ),
    ).toEqual({ code: '23505', constraint: 'skill_runs_skill_scheduled_uq' });
    await withOrg(app.db, 'org_a', async (tx) => {
      const manual = { orgId: 'org_a', skillId: skillA, version: 1, trigger: 'manual' as const };
      const rows = await tx.insert(skillRuns).values([manual, manual]).returning();
      expect(rows).toHaveLength(2);
      for (const r of rows) await tx.delete(skillRuns).where(eq(skillRuns.id, r.id));
    });
  });

  it('snapshots output and channel into a run; a deleted channel clears it; owner_left is storable', async () => {
    await withOrg(app.db, 'org_a', async (tx) => {
      const channelId = randomUUID();
      await tx.insert(deliveryChannels).values({
        id: channelId,
        orgId: 'org_a',
        kind: 'teams',
        name: 'Snapshot channel',
        hint: 'x',
        secret: 'x',
        createdBy: 'user_1',
      });
      const [run] = await tx
        .insert(skillRuns)
        .values({
          orgId: 'org_a',
          skillId: skillA,
          version: 1,
          trigger: 'manual',
          status: 'skipped',
          resultCode: 'owner_left',
          outputKind: 'teams',
          channelId,
        })
        .returning();
      expect(run).toMatchObject({
        status: 'skipped',
        resultCode: 'owner_left',
        outputKind: 'teams',
        channelId,
      });
      await tx.delete(deliveryChannels).where(eq(deliveryChannels.id, channelId));
      const [after] = await tx
        .select()
        .from(skillRuns)
        .where(eq(skillRuns.id, run?.id ?? ''));
      expect(after?.channelId).toBeNull();
      expect(after?.outputKind).toBe('teams');
      await tx.delete(skillRuns).where(eq(skillRuns.id, run?.id ?? ''));
    });
  });

  it('allows one SMTP channel per org, unique channel names, any number of webhooks', async () => {
    const channel = (orgId: string, kind: 'smtp' | 'slack' | 'teams', name: string) => ({
      id: randomUUID(),
      orgId,
      kind,
      name,
      hint: 'x',
      secret: 'x',
      createdBy: 'u',
    });
    const insert = (orgId: string, kind: 'smtp' | 'slack' | 'teams', name: string) =>
      withOrg(app.db, orgId, (tx) =>
        tx.insert(deliveryChannels).values(channel(orgId, kind, name)),
      );
    await insert('org_u', 'smtp', 'Mail');
    expect(await pgError(insert('org_u', 'smtp', 'Mail 2'))).toEqual({
      code: '23505',
      constraint: 'delivery_channels_one_smtp_uq',
    });
    expect(await pgError(insert('org_u', 'slack', 'Mail'))).toEqual({
      code: '23505',
      constraint: 'delivery_channels_org_name_uq',
    });
    // Another org has its own SMTP channel, and one org may have several Slack/Teams channels.
    expect(await pgError(insert('org_v', 'smtp', 'Mail'))).toBe('no error');
    expect(await pgError(insert('org_u', 'slack', 'Slack 1'))).toBe('no error');
    expect(await pgError(insert('org_u', 'slack', 'Slack 2'))).toBe('no error');
    expect(await pgError(insert('org_u', 'teams', 'Teams 1'))).toBe('no error');
    for (const org of ['org_u', 'org_v']) {
      await withOrg(app.db, org, (tx) => tx.delete(deliveryChannels));
    }
  });

  it('allows one background model per org', async () => {
    const connection = (orgId: string, isBackground: boolean) => ({
      id: randomUUID(),
      orgId,
      label: randomUUID(),
      provider: 'openai' as const,
      model: 'm',
      secret: 'x',
      isBackground,
      createdBy: 'u',
    });
    const insert = (orgId: string, isBackground: boolean) =>
      withOrg(app.db, orgId, (tx) =>
        tx.insert(llmConnections).values(connection(orgId, isBackground)),
      );
    expect(await pgError(insert('org_u', true))).toBe('no error');
    expect(await pgError(insert('org_u', true))).toEqual({
      code: '23505',
      constraint: 'llm_connections_one_background_uq',
    });
    expect(await pgError(insert('org_u', false))).toBe('no error');
    expect(await pgError(insert('org_v', true))).toBe('no error');
    for (const org of ['org_u', 'org_v']) {
      await withOrg(app.db, org, (tx) => tx.delete(llmConnections));
    }
  });

  it('refuses cross-org writes on every Phase 4 table', async () => {
    const before = await countAll('org_a');
    const inserts: Record<string, () => Promise<unknown>> = {
      skills: () =>
        withOrg(app.db, 'org_b', (tx) => tx.insert(skills).values(skillRow('org_a', 'other'))),
      skill_versions: () =>
        withOrg(app.db, 'org_b', (tx) =>
          tx.insert(skillVersions).values({
            orgId: 'org_a',
            skillId: skillA,
            version: 9,
            document: 'x',
            createdBy: 'u',
          }),
        ),
      skill_runs: () =>
        withOrg(app.db, 'org_b', (tx) =>
          tx
            .insert(skillRuns)
            .values({ orgId: 'org_a', skillId: skillA, version: 1, trigger: 'manual' }),
        ),
      delivery_channels: () =>
        withOrg(app.db, 'org_b', (tx) =>
          tx.insert(deliveryChannels).values({
            id: randomUUID(),
            orgId: 'org_a',
            kind: 'teams',
            name: 'x',
            hint: 'x',
            secret: 'x',
            createdBy: 'u',
          }),
        ),
    };
    for (const [table, run] of Object.entries(inserts)) {
      expect({ table, ...((await pgError(run())) as object) }).toMatchObject({
        table,
        code: '42501',
      });
    }
    for (const table of PHASE4_TABLES) {
      const [updated, deleted] = await withOrg(app.db, 'org_b', async (tx) => [
        (await tx.execute(
          sql`update ${sql.identifier(table)} set org_id = 'org_b' where org_id = 'org_a' returning 1`,
        )) as unknown as unknown[],
        (await tx.execute(
          sql`delete from ${sql.identifier(table)} where org_id = 'org_a' returning 1`,
        )) as unknown as unknown[],
      ]);
      expect({ table, updated: updated?.length, deleted: deleted?.length }).toEqual({
        table,
        updated: 0,
        deleted: 0,
      });
    }
    expect(await countAll('org_a')).toEqual(before);
  });

  it('deleting a skill removes its versions and runs, not the channel or builder calls', async () => {
    await withOrg(app.db, 'org_a', (tx) => tx.delete(skills).where(eq(skills.id, skillA)));
    expect(await countAll('org_a')).toEqual({
      delivery_channels: 1,
      skill_builder_calls: 1,
      skill_runs: 0,
      skill_versions: 0,
      skills: 0,
    });
  });

  it('purging an org empties every Phase 4 table for it and only it', async () => {
    await withOrg(app.db, 'org_a', async (tx) => {
      await tx.delete(deliveryChannels);
      await seed(tx, 'org_a');
    });
    const purged = await withOrg(app.db, 'org_a', (tx) => purgeOrgTenantRows(tx, 'org_a'));
    expect(purged).toEqual(expect.arrayContaining(PHASE4_TABLES));
    expect(Object.values(await countAll('org_a')).every((n) => n === 0)).toBe(true);
    expect(Object.values(await countAll('org_b')).every((n) => n === 1)).toBe(true);
  });
});
