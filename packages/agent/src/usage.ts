import { agentUsage, type Db, user, withOrg } from '@agile/db';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { AgentActor } from './deps';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

/** Prices per million tokens, in millionths of a currency unit (null = unknown). */
export interface Prices {
  inputMicros: number | null;
  outputMicros: number | null;
}

/** Cost of one reply, in millionths; null unless both prices are known. Cached input is billed as input. */
export function costMicros(usage: TokenUsage, prices: Prices): number | null {
  if (prices.inputMicros === null || prices.outputMicros === null) return null;
  return Math.round(
    (usage.inputTokens * prices.inputMicros + usage.outputTokens * prices.outputMicros) / 1_000_000,
  );
}

/** Reads the AI SDK's `totalUsage` defensively (providers omit fields). */
export function tokenUsageOf(total: {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number };
}): TokenUsage {
  const n = (v: number | undefined) =>
    Number.isFinite(v) && (v ?? 0) > 0 ? Math.round(v ?? 0) : 0;
  return {
    inputTokens: n(total.inputTokens),
    outputTokens: n(total.outputTokens),
    cachedInputTokens: n(total.inputTokenDetails?.cacheReadTokens),
  };
}

export async function recordUsage(
  db: Db,
  actor: AgentActor,
  entry: {
    conversationId: string;
    llmConnectionId: string;
    provider: string;
    model: string;
    usage: TokenUsage;
    prices: Prices;
  },
): Promise<void> {
  await withOrg(db, actor.orgId, (tx) =>
    tx.insert(agentUsage).values({
      orgId: actor.orgId,
      userId: actor.userId,
      conversationId: entry.conversationId,
      llmConnectionId: entry.llmConnectionId,
      provider: entry.provider,
      model: entry.model,
      ...entry.usage,
      costMicros: costMicros(entry.usage, entry.prices),
    }),
  );
}

export interface UsageTotals {
  userId: string;
  /** The member's display name (null once the account is gone). */
  name: string | null;
  replies: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum of known costs, in millionths. */
  costMicros: number;
  /** Replies whose cost is unknown (no price set at the time). */
  unpricedReplies: number;
}

/** Usage since `since`, per user (only the actor's own row unless `allUsers`). */
export async function usageSummary(
  db: Db,
  actor: AgentActor,
  opts: { since: Date; allUsers: boolean },
): Promise<UsageTotals[]> {
  // Sums of bigint columns exceed 32 bits: cast to bigint (postgres-js returns a string) and
  // read with Number() (exact up to 2^53).
  const rows = await withOrg(db, actor.orgId, (tx) =>
    tx
      .select({
        userId: agentUsage.userId,
        name: user.name,
        replies: sql<string>`count(*)::bigint`,
        inputTokens: sql<string>`coalesce(sum(${agentUsage.inputTokens}), 0)::bigint`,
        outputTokens: sql<string>`coalesce(sum(${agentUsage.outputTokens}), 0)::bigint`,
        costMicros: sql<string>`coalesce(sum(${agentUsage.costMicros}), 0)::bigint`,
        unpricedReplies: sql<string>`count(*) filter (where ${agentUsage.costMicros} is null)::bigint`,
      })
      .from(agentUsage)
      .leftJoin(user, eq(user.id, agentUsage.userId))
      .where(
        and(
          eq(agentUsage.orgId, actor.orgId),
          gte(agentUsage.createdAt, opts.since),
          opts.allUsers ? undefined : eq(agentUsage.userId, actor.userId),
        ),
      )
      .groupBy(agentUsage.userId, user.name),
  );
  return rows.map((r) => ({
    userId: r.userId,
    name: r.name,
    replies: Number(r.replies),
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    costMicros: Number(r.costMicros),
    unpricedReplies: Number(r.unpricedReplies),
  }));
}
