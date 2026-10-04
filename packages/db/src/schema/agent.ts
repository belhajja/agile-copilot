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
    createdAt,
    updatedAt,
  },
  (t) => [
    index('agent_conversations_owner_idx').on(t.orgId, t.userId, t.updatedAt),
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
    uniqueIndex('agent_approvals_conversation_call_uq').on(t.conversationId, t.toolCallId),
    tenantPolicy('agent_approvals', t.orgId),
  ],
);

/**
 * Token usage of one agent reply (all its model calls). Kept when the conversation or the LLM
 * connection is deleted, so no foreign keys: spend history must survive both.
 */
export const agentUsage = pgTable(
  'agent_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    userId: text('user_id').notNull(),
    conversationId: uuid('conversation_id'),
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
    tenantPolicy('agent_usage', t.orgId),
  ],
);
