import { can } from '@agile/auth';
import { ForbiddenError } from '@agile/connections';
import { type Actor, agentUsage, type Db, skillBuilderCalls, user, withOrg } from '@agile/db';
import { and, eq, gte, isNotNull, isNull, lt, sql } from 'drizzle-orm';

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

/** A cost that does not fit a safe integer (absurd token counts or prices). Stable code. */
export class CostOverflowError extends Error {
  override name = 'CostOverflowError';
  readonly code = 'cost_overflow';
  constructor() {
    super('The reply cost is out of range.');
  }
}

const big = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new CostOverflowError();
  return BigInt(n);
};

/**
 * Cost of one reply, in millionths; null unless both prices are known. Cached input is billed as
 * input. Exact integer math (rounded half up); throws `CostOverflowError` past 2^53.
 */
export function costMicros(usage: TokenUsage, prices: Prices): number | null {
  if (prices.inputMicros === null || prices.outputMicros === null) return null;
  const total =
    big(usage.inputTokens) * big(prices.inputMicros) +
    big(usage.outputTokens) * big(prices.outputMicros);
  const cost = (total + 500_000n) / 1_000_000n;
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) throw new CostOverflowError();
  return Number(cost);
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
  actor: Actor,
  entry: {
    /** The chat conversation, or null for skill runs and drafts. */
    conversationId: string | null;
    /** The skill run (runs only; null for chat replies, drafts and unrecorded runs). */
    skillRunId?: string | null;
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
      skillRunId: entry.skillRunId ?? null,
      llmConnectionId: entry.llmConnectionId,
      provider: entry.provider,
      model: entry.model,
      ...entry.usage,
      costMicros: costMicros(entry.usage, entry.prices),
    }),
  );
}

/** Skill-builder drafts and previews per member and rolling hour (P4-R16): BYOK spend bound. */
const SKILL_BUILDER_HOURLY_LIMIT = 20;
const BUILDER_WINDOW_MS = 3_600_000;

/**
 * Reserves one skill-builder call (a draft or a preview) for the actor before the model is called;
 * false when they already made `SKILL_BUILDER_HOURLY_LIMIT` in the last hour (P4-R29). The count
 * and the insert run under a per-member transaction lock, so parallel requests cannot overshoot,
 * and a reservation counts even when the call or its metering fails.
 */
export async function reserveBuilderCall(db: Db, actor: Actor, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - BUILDER_WINDOW_MS);
  return withOrg(db, actor.orgId, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`skill_builder:${actor.orgId}:${actor.userId}`}))`,
    );
    const mine = and(
      eq(skillBuilderCalls.orgId, actor.orgId),
      eq(skillBuilderCalls.userId, actor.userId),
    );
    // The window's older rows are no longer needed.
    await tx.delete(skillBuilderCalls).where(and(mine, lt(skillBuilderCalls.createdAt, since)));
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(skillBuilderCalls)
      .where(and(mine, gte(skillBuilderCalls.createdAt, since)));
    if ((row?.n ?? 0) >= SKILL_BUILDER_HOURLY_LIMIT) return false;
    await tx
      .insert(skillBuilderCalls)
      .values({ orgId: actor.orgId, userId: actor.userId, createdAt: now });
    return true;
  });
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

/**
 * Usage since `since`, per user: only the actor's own row unless `allUsers`, which requires
 * `usage.view_all` (owners and admins; `ForbiddenError` otherwise).
 */
export async function usageSummary(
  db: Db,
  actor: Actor,
  opts: {
    since: Date;
    allUsers: boolean;
    /** `chat`: assistant replies; `skills`: skill runs, previews and drafts. Default: both. */
    source?: 'chat' | 'skills';
  },
): Promise<UsageTotals[]> {
  if (opts.allUsers && !can(actor.roles, 'usage.view_all')) {
    throw new ForbiddenError('Only workspace owners and admins can see everyone’s usage');
  }
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
          opts.source === 'chat' ? isNotNull(agentUsage.conversationId) : undefined,
          opts.source === 'skills' ? isNull(agentUsage.conversationId) : undefined,
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
