import { sql } from 'drizzle-orm';
import { type AnyPgColumn, pgPolicy, timestamp } from 'drizzle-orm/pg-core';

/** Rows are visible/writable only when app.current_org_id (set by withOrg) matches. */
export const tenantPolicy = (table: string, orgId: AnyPgColumn) =>
  pgPolicy(`${table}_tenant_isolation`, {
    as: 'permissive',
    for: 'all',
    to: 'public',
    using: sql`${orgId} = current_setting('app.current_org_id', true)`,
    withCheck: sql`${orgId} = current_setting('app.current_org_id', true)`,
  });

export const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
export const updatedAt = timestamp('updated_at', { withTimezone: true })
  .notNull()
  .defaultNow()
  .$onUpdate(() => new Date());
