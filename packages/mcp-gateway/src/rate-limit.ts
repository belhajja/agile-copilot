import { type Db, mcpRateBuckets, withOrg } from '@agile/db';
import { sql } from 'drizzle-orm';

/** Default requests per token per minute (`MCP_RATE_LIMIT_PER_MINUTE` overrides it). */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;

/**
 * Fixed one-minute windows counted in Postgres (shared by every web replica, no Redis). One atomic
 * upsert per request, so concurrent requests never lose a count. Returns whether this request is
 * allowed and, when not, the seconds until the next window.
 */
export async function takeRequest(
  db: Db,
  key: { orgId: string; tokenId: string },
  limit: number,
  now: Date = new Date(),
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const [row] = await withOrg(db, key.orgId, (tx) =>
    tx
      .insert(mcpRateBuckets)
      .values({ orgId: key.orgId, tokenId: key.tokenId, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [mcpRateBuckets.tokenId, mcpRateBuckets.windowStart],
        set: { count: sql`${mcpRateBuckets.count} + 1` },
      })
      .returning({ count: mcpRateBuckets.count }),
  );
  if ((row?.count ?? 1) <= limit) return { allowed: true };
  const next = windowStart.getTime() + 60_000;
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((next - now.getTime()) / 1000)),
  };
}
