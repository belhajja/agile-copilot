import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { startTestDatabase, type TestDatabase } from './testing';

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

/** Closed sets and bounds the app validates are closed in the schema too (A-m11). */
describe('Phase 5 CHECK constraints', () => {
  let tdb: TestDatabase;
  let owner: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = createDb(tdb.ownerUrl, { max: 1 });
    await owner.db.execute(
      sql`insert into "user" (id, name, email) values ('c1', 'C', 'c1@example.com')`,
    );
  });
  afterAll(async () => {
    await owner?.close();
    await tdb?.stop();
  });

  it('allows only the known export kinds', async () => {
    for (const kind of ['personal', 'audit', 'deletion']) {
      await owner.db.execute(
        sql`insert into personal_data_exports (user_id, kind) values ('c1', ${kind})`,
      );
    }
    for (const kind of ['other', 'Personal', '']) {
      expect(
        await pgError(
          owner.db.execute(
            sql`insert into personal_data_exports (user_id, kind) values ('c1', ${kind})`,
          ),
        ),
      ).toEqual({ code: '23514', constraint: 'personal_data_exports_kind_check' });
    }
  });

  it('allows only known plans (or none) on a subscription row', async () => {
    await owner.db.execute(sql`insert into billing_subscriptions (org_id, stripe_customer_id, plan)
      values ('o1', 'cus_1', null), ('o2', 'cus_2', 'team'), ('o3', 'cus_3', 'free')`);
    for (const plan of ['enterprise', 'Team', '']) {
      expect(
        await pgError(
          owner.db.execute(sql`insert into billing_subscriptions (org_id, stripe_customer_id, plan)
            values ('o4', 'cus_4', ${plan})`),
        ),
      ).toEqual({ code: '23514', constraint: 'billing_subscriptions_plan_check' });
    }
  });

  it('keeps retention periods within their bounds', async () => {
    const insert = (conversation: number, usage: number, audit: number) =>
      owner.db.execute(sql`insert into org_settings
        (org_id, conversation_retention_days, usage_retention_days, audit_retention_days)
        values (${`o_${conversation}_${usage}_${audit}`}, ${conversation}, ${usage}, ${audit})`);
    await insert(7, 30, 90);
    await insert(3650, 3650, 3650);
    const cases: [number, number, number, string][] = [
      [6, 30, 90, 'org_settings_conversation_retention_days_check'],
      [3651, 30, 90, 'org_settings_conversation_retention_days_check'],
      [7, 29, 90, 'org_settings_usage_retention_days_check'],
      [7, 3651, 90, 'org_settings_usage_retention_days_check'],
      [7, 30, 89, 'org_settings_audit_retention_days_check'],
      [7, 30, 3651, 'org_settings_audit_retention_days_check'],
    ];
    for (const [c, u, a, constraint] of cases) {
      expect(await pgError(insert(c, u, a))).toEqual({ code: '23514', constraint });
    }
  });
});
