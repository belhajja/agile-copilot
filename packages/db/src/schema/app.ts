import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Rows are visible/writable only when app.current_org_id (set by withOrg) matches. */
const tenantPolicy = (table: string, orgId: AnyPgColumn) =>
  pgPolicy(`${table}_tenant_isolation`, {
    as: 'permissive',
    for: 'all',
    to: 'public',
    using: sql`${orgId} = current_setting('app.current_org_id', true)`,
    withCheck: sql`${orgId} = current_setting('app.current_org_id', true)`,
  });

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp('updated_at', { withTimezone: true })
  .notNull()
  .defaultNow()
  .$onUpdate(() => new Date());

export const jiraDeployment = pgEnum('jira_deployment', ['cloud', 'datacenter']);
export const jiraAuthType = pgEnum('jira_auth_type', ['basic', 'oauth', 'pat']);
export const connectionStatus = pgEnum('connection_status', ['untested', 'ok', 'error']);
export const llmProvider = pgEnum('llm_provider', [
  'anthropic',
  'openai',
  'google',
  'azure',
  'mistral',
  'openai_compatible',
]);

export const orgDataKeys = pgTable(
  'org_data_keys',
  {
    orgId: text('org_id').primaryKey(),
    kekVersion: integer('kek_version').notNull(),
    wrappedDek: text('wrapped_dek').notNull(),
    createdAt,
  },
  (t) => [tenantPolicy('org_data_keys', t.orgId)],
);

export const jiraConnections = pgTable(
  'jira_connections',
  {
    // App-generated (not defaultRandom) so the secret can be encrypted bound to this id before insert.
    id: uuid('id').primaryKey(),
    orgId: text('org_id').notNull(),
    name: text('name').notNull(),
    deployment: jiraDeployment('deployment').notNull(),
    authType: jiraAuthType('auth_type').notNull(),
    baseUrl: text('base_url').notNull(),
    cloudId: text('cloud_id'),
    accountId: text('account_id'),
    accountName: text('account_name'),
    secret: text('secret').notNull(),
    status: connectionStatus('status').notNull().default('untested'),
    lastError: text('last_error'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex('jira_connections_org_url_uq').on(t.orgId, t.baseUrl),
    tenantPolicy('jira_connections', t.orgId),
  ],
);

export const llmConnections = pgTable(
  'llm_connections',
  {
    id: uuid('id').primaryKey(),
    orgId: text('org_id').notNull(),
    label: text('label').notNull(),
    provider: llmProvider('provider').notNull(),
    model: text('model').notNull(),
    baseUrl: text('base_url'),
    azureResourceName: text('azure_resource_name'),
    keyHint: text('key_hint'),
    secret: text('secret').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    status: connectionStatus('status').notNull().default('untested'),
    lastError: text('last_error'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [
    index('llm_connections_org_idx').on(t.orgId),
    uniqueIndex('llm_connections_one_default_uq').on(t.orgId).where(sql`${t.isDefault}`),
    tenantPolicy('llm_connections', t.orgId),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    actorUserId: text('actor_user_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt,
  },
  (t) => [
    index('audit_log_org_created_idx').on(t.orgId, t.createdAt),
    tenantPolicy('audit_log', t.orgId),
  ],
);
