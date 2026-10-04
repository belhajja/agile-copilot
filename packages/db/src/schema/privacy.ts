import { boolean, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth';
import { tenantPolicy, updatedAt } from './tenant';

/**
 * Workspace-wide settings owners and admins change (Phase 5): data retention and external MCP
 * access. One row per workspace, created on first change; absent = the defaults.
 */
export const orgSettings = pgTable(
  'org_settings',
  {
    orgId: text('org_id').primaryKey(),
    /** Conversations (with their messages and approvals) idle longer than this are deleted. */
    conversationRetentionDays: integer('conversation_retention_days').notNull().default(180),
    /** Token-usage records older than this are deleted. */
    usageRetentionDays: integer('usage_retention_days').notNull().default(730),
    /** Audit entries older than this are deleted (never younger than 90 days, enforced in SQL). */
    auditRetentionDays: integer('audit_retention_days').notNull().default(365),
    /** Members may create personal tokens for external MCP clients (off until an admin allows it). */
    externalMcpEnabled: boolean('external_mcp_enabled').notNull().default(false),
    updatedBy: text('updated_by'),
    updatedAt,
  },
  (t) => [tenantPolicy('org_settings', t.orgId)],
);

/**
 * Workspaces that were deleted, so the retention job can purge their audit trail later (it is
 * kept for 90 days as the record of the deletion). Not tenant data: an id and a date.
 */
export const deletedOrganizations = pgTable('deleted_organizations', {
  deletedOrgId: text('deleted_org_id').primaryKey(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Exports (personal data, audit log) and account-deletion attempts, to throttle them: one export
 * running per person and a few per hour. Not tenant data (an export spans workspaces); deleted
 * with the person.
 */
export const personalDataExports = pgTable(
  'personal_data_exports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /**
     * Throttled separately per kind: 'personal' (GDPR access), 'audit' (audit log export) or
     * 'deletion' (an account-deletion attempt, P5-R44). A CHECK closes the set (0033).
     */
    kind: text('kind').notNull().default('personal'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    /** Null while the export streams (or after a crash: stale after a while, see @agile/privacy). */
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('personal_data_exports_user_started_idx').on(t.userId, t.startedAt)],
);
