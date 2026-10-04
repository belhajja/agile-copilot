import { sql } from 'drizzle-orm';
import type { Tx } from './client';

/**
 * Deletes every row of one organisation from every tenant table (any public table with an
 * `org_id` column), except the append-only `audit_log`. Tables are discovered at run time, so
 * tables added in later phases are purged without touching this function. Run inside
 * `withOrg(db, orgId, …)`: RLS then confines the deletes to that org a second time.
 * Requires every foreign key between tenant tables to be ON DELETE CASCADE, or SET NULL for the one
 * allowlisted `skill_runs_channel_id_delivery_channels_id_fk` (schema guard test).
 */
export async function purgeOrgTenantRows(tx: Tx, orgId: string): Promise<string[]> {
  const tables = (await tx.execute(sql`
    select c.table_name as name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and c.column_name = 'org_id'
      and t.table_type = 'BASE TABLE' and c.table_name <> 'audit_log'
    order by c.table_name
  `)) as unknown as { name: string }[];
  for (const { name } of tables) {
    await tx.execute(sql`delete from ${sql.identifier(name)} where org_id = ${orgId}`);
  }
  return tables.map((t) => t.name);
}
