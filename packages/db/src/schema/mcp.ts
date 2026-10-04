import { index, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, tenantPolicy } from './tenant';

/**
 * Personal access tokens for external MCP clients (Claude Desktop, …): read-only analytics of one
 * workspace as one person. Only a SHA-256 of the token is stored; the token is shown once.
 */
export const mcpTokens = pgTable(
  'mcp_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    userId: text('user_id').notNull(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** The first characters of the token, to recognise it in lists. */
    prefix: text('prefix').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt,
  },
  (t) => [
    index('mcp_tokens_hash_idx').on(t.orgId, t.tokenHash),
    index('mcp_tokens_owner_idx').on(t.orgId, t.userId),
    tenantPolicy('mcp_tokens', t.orgId),
  ],
);

/** Requests per token per minute (fixed windows), for the external MCP rate limit. */
export const mcpRateBuckets = pgTable(
  'mcp_rate_buckets',
  {
    orgId: text('org_id').notNull(),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => mcpTokens.id, { onDelete: 'cascade' }),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.tokenId, t.windowStart] }),
    tenantPolicy('mcp_rate_buckets', t.orgId),
  ],
);
