import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, tenantPolicy, updatedAt } from './tenant';

export const agentMessageRole = pgEnum('agent_message_role', ['user', 'assistant']);
export const agentApprovalStatus = pgEnum('agent_approval_status', [
  'pending',
  'approved',
  'denied',
  'executed',
  'failed',
]);

/** One chat thread. Private to the user who started it. */
export const agentConversations = pgTable(
  'agent_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    userId: text('user_id').notNull(),
    title: text('title').notNull().default(''),
    /**
     * The chat turn holding the conversation (a lease): set when a turn starts, cleared when its
     * reply is stored. A second turn is refused while it is set and younger than the lease.
     */
    turnId: uuid('turn_id'),
    turnStartedAt: timestamp('turn_started_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    index('agent_conversations_owner_idx').on(t.orgId, t.userId, t.updatedAt),
    // Person lookup across workspaces (user_org_ids: GDPR export and erasure).
    index('agent_conversations_user_idx').on(t.userId),
    tenantPolicy('agent_conversations', t.orgId),
  ],
);

/**
 * The conversation as AI SDK UI messages (`parts` is the message's parts array), in order. The
 * server is the only writer: the browser never supplies history, tool inputs or tool outputs.
 */
export const agentMessages = pgTable(
  'agent_messages',
  {
    orgId: text('org_id').notNull(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => agentConversations.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    seq: integer('seq').notNull(),
    role: agentMessageRole('role').notNull(),
    parts: jsonb('parts').$type<unknown[]>().notNull(),
    createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.id] }),
    uniqueIndex('agent_messages_conversation_seq_uq').on(t.conversationId, t.seq),
    tenantPolicy('agent_messages', t.orgId),
  ],
);

/**
 * A Jira write the model proposed. Bound to the user, the conversation, the tool call and a hash
 * of the exact input; executed at most once, and only after that user approved it.
 */
export const agentApprovals = pgTable(
  'agent_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    userId: text('user_id').notNull(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => agentConversations.id, { onDelete: 'cascade' }),
    approvalId: text('approval_id').notNull(),
    toolCallId: text('tool_call_id').notNull(),
    toolName: text('tool_name').notNull(),
    input: jsonb('input').$type<Record<string, unknown>>().notNull(),
    inputHash: text('input_hash').notNull(),
    status: agentApprovalStatus('status').notNull().default('pending'),
    /** Stable outcome code once executed (never raw error text). */
    resultCode: text('result_code'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    createdAt,
  },
  (t) => [
    uniqueIndex('agent_approvals_conversation_approval_uq').on(t.conversationId, t.approvalId),
    // Not unique: some providers reuse tool call ids; the claim matches the call id and the hash.
    index('agent_approvals_conversation_call_idx').on(t.conversationId, t.toolCallId),
    // Person lookup across workspaces (user_org_ids: GDPR export and erasure).
    index('agent_approvals_user_idx').on(t.userId),
    tenantPolicy('agent_approvals', t.orgId),
  ],
);

/**
 * Token usage of one agent reply or skill run (all its model calls). Kept when the conversation,
 * the skill run or the LLM connection is deleted, so no foreign keys: spend history must survive.
 */
export const agentUsage = pgTable(
  'agent_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    userId: text('user_id').notNull(),
    conversationId: uuid('conversation_id'),
    /** Set for background skill runs and builder previews' runs (no conversation). */
    skillRunId: uuid('skill_run_id'),
    llmConnectionId: uuid('llm_connection_id'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cachedInputTokens: bigint('cached_input_tokens', { mode: 'number' }).notNull().default(0),
    /** Cost in millionths of the price currency; null when the connection has no price set. */
    costMicros: bigint('cost_micros', { mode: 'number' }),
    createdAt,
  },
  (t) => [
    index('agent_usage_org_created_idx').on(t.orgId, t.createdAt),
    index('agent_usage_user_created_idx').on(t.orgId, t.userId, t.createdAt),
    // Person lookup across workspaces (user_org_ids: GDPR export and erasure).
    index('agent_usage_user_idx').on(t.userId),
    tenantPolicy('agent_usage', t.orgId),
  ],
);
