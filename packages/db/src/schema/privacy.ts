import { boolean, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
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
