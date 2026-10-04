import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { can, parseRoles } from '@agile/auth';
import { type Db, isUuid, mcpTokens, member, recordAudit, type Tx, withOrg } from '@agile/db';
import { getWorkspaceSettings } from '@agile/privacy';
import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';

export interface TokenActor {
  orgId: string;
  userId: string;
  roles: readonly string[];
}

export interface GatewayDeps {
  db: Db;
  /** Whether the workspace's plan includes external MCP access (always true in self-host). */
  planAllowsMcp: (orgId: string) => Promise<boolean>;
  now?: () => Date;
}

export type TokenErrorCode =
  | 'forbidden_role'
  | 'mcp_disabled'
  | 'plan_limit'
  | 'too_many_tokens'
  | 'invalid_input'
  | 'not_found';

export class TokenError extends Error {
  override name = 'TokenError';
  constructor(readonly code: TokenErrorCode) {
    super(code);
  }
}

/** Active tokens one person may hold in one workspace. */
export const MAX_ACTIVE_TOKENS = 10;
export const DEFAULT_TOKEN_DAYS = 90;
/** `last_used_at` is written at most once per this period per token (no write per request). */
export const LAST_USED_THROTTLE_MS = 5 * 60_000;
const DAY = 86_400_000;

export const createTokenSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    expiresInDays: z.number().int().min(30).max(365).default(DEFAULT_TOKEN_DAYS),
  })
  .strict();

/**
 * `acp_<workspace id>.<43 random characters>`. The workspace id lets the server look the token up
 * under that workspace's row-level security (no cross-tenant lookup exists); the secret part is 256
 * random bits, stored only as a SHA-256.
 */
const TOKEN_PATTERN = /^acp_([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{43})$/;
/** Workspace ids a token can carry (the first group of `TOKEN_PATTERN`). */
const ORG_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function parseToken(token: string): { orgId: string } | null {
  const m = TOKEN_PATTERN.exec(token);
  return m?.[1] ? { orgId: m[1] } : null;
}

/** What lists show to recognise a token: the workspace part and the first 4 secret characters. */
const prefixOf = (token: string) => token.slice(0, token.indexOf('.') + 5);

/** The person's current membership: roles and since when (null when not a member). */
async function membership(
  db: Db | Tx,
  orgId: string,
  userId: string,
): Promise<{ roles: string[]; since: Date } | null> {
  const [row] = await db
    .select({ role: member.role, createdAt: member.createdAt })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1);
  return row ? { roles: parseRoles(row.role), since: row.createdAt } : null;
}

/**
 * Revokes the person's tokens issued before their current membership began (they left or were
 * removed, then joined again): such tokens never work again, and no longer count as active.
 */
const revokeEarlierMembershipTokens = (tx: Tx, orgId: string, userId: string, since: Date) =>
  tx
    .update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(mcpTokens.orgId, orgId),
        eq(mcpTokens.userId, userId),
        isNull(mcpTokens.revokedAt),
        lt(mcpTokens.createdAt, since),
      ),
    );

/** Why this person cannot use external MCP in this workspace now, or null when they can. */
export async function mcpAccessProblem(
  deps: GatewayDeps,
  orgId: string,
  roles: readonly string[],
): Promise<TokenErrorCode | null> {
  if (!can(roles, 'mcp.token')) return 'forbidden_role';
  if (!(await getWorkspaceSettings(deps.db, orgId)).externalMcpEnabled) return 'mcp_disabled';
  if (!(await deps.planAllowsMcp(orgId))) return 'plan_limit';
  return null;
}

/** Creates a token for the actor; the plaintext is returned once and never stored. */
export async function createMcpToken(
  deps: GatewayDeps,
  actor: TokenActor,
  input: unknown,
): Promise<{ id: string; token: string; prefix: string; expiresAt: Date }> {
  // The token must carry the workspace id, or it would never authenticate.
  if (!ORG_ID_PATTERN.test(actor.orgId)) throw new TokenError('invalid_input');
  const problem = await mcpAccessProblem(deps, actor.orgId, actor.roles);
  if (problem) throw new TokenError(problem);
  const parsed = createTokenSchema.safeParse(input);
  if (!parsed.success) throw new TokenError('invalid_input');
  const now = deps.now?.() ?? new Date();
  const token = `acp_${actor.orgId}.${randomBytes(32).toString('base64url')}`;
  const prefix = prefixOf(token);
  const expiresAt = new Date(now.getTime() + parsed.data.expiresInDays * DAY);
  const created = await withOrg(deps.db, actor.orgId, async (tx) => {
    // Serialises one person's creations, so concurrent requests cannot pass the cap together.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`mcp_tokens:${actor.orgId}:${actor.userId}`}))`,
    );
    const current = await membership(tx, actor.orgId, actor.userId);
    if (current) await revokeEarlierMembershipTokens(tx, actor.orgId, actor.userId, current.since);
    const active = await tx.$count(
      mcpTokens,
      and(
        eq(mcpTokens.userId, actor.userId),
        isNull(mcpTokens.revokedAt),
        gt(mcpTokens.expiresAt, now),
      ),
    );
    if (active >= MAX_ACTIVE_TOKENS) return null;
    const [row] = await tx
      .insert(mcpTokens)
      .values({
        orgId: actor.orgId,
        userId: actor.userId,
        name: parsed.data.name,
        tokenHash: hashToken(token),
        prefix,
        expiresAt,
        // The app clock, like the membership's start it is compared with.
        createdAt: new Date(),
      })
      .returning({ id: mcpTokens.id });
    if (!row) return null;
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'mcp.token_created',
      targetType: 'mcp_token',
      targetId: row.id,
      metadata: { expiresAt: expiresAt.toISOString() },
    });
    return row;
  });
  if (!created) throw new TokenError('too_many_tokens');
  return { id: created.id, token, prefix, expiresAt };
}

export interface TokenView {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** One's own tokens; owners and admins see everyone's (to revoke them). */
export async function listMcpTokens(db: Db, actor: TokenActor): Promise<TokenView[]> {
  const all = can(actor.roles, 'members.manage');
  return withOrg(db, actor.orgId, (tx) =>
    tx
      .select({
        id: mcpTokens.id,
        userId: mcpTokens.userId,
        name: mcpTokens.name,
        prefix: mcpTokens.prefix,
        createdAt: mcpTokens.createdAt,
        expiresAt: mcpTokens.expiresAt,
        lastUsedAt: mcpTokens.lastUsedAt,
        revokedAt: mcpTokens.revokedAt,
      })
      .from(mcpTokens)
      .where(all ? undefined : eq(mcpTokens.userId, actor.userId))
      .orderBy(desc(mcpTokens.createdAt)),
  );
}

/** Revokes a token: its owner, or an owner/admin of the workspace. */
export async function revokeMcpToken(db: Db, actor: TokenActor, tokenId: string): Promise<void> {
  if (!isUuid(tokenId)) throw new TokenError('not_found');
  const all = can(actor.roles, 'members.manage');
  const revoked = await withOrg(db, actor.orgId, async (tx) => {
    const rows = await tx
      .update(mcpTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(mcpTokens.id, tokenId),
          isNull(mcpTokens.revokedAt),
          all ? undefined : eq(mcpTokens.userId, actor.userId),
        ),
      )
      .returning({ id: mcpTokens.id });
    if (rows.length > 0) {
      await recordAudit(tx, {
        orgId: actor.orgId,
        actorUserId: actor.userId,
        action: 'mcp.token_revoked',
        targetType: 'mcp_token',
        targetId: tokenId,
      });
    }
    return rows.length > 0;
  });
  if (!revoked) throw new TokenError('not_found');
}

export interface TokenIdentity {
  tokenId: string;
  orgId: string;
  userId: string;
  roles: string[];
}

/**
 * Who a bearer token acts for, re-checked on every request: not revoked or expired, its owner
 * still a member whose role allows it, external MCP still enabled for the workspace and in its
 * plan. Null otherwise (the caller answers 401 without saying why).
 */
export async function authenticateToken(
  deps: GatewayDeps,
  token: string,
): Promise<TokenIdentity | null> {
  const parsed = parseToken(token);
  if (!parsed) return null;
  const hash = hashToken(token);
  const now = deps.now?.() ?? new Date();
  const [row] = await withOrg(deps.db, parsed.orgId, (tx) =>
    tx
      .select({
        id: mcpTokens.id,
        orgId: mcpTokens.orgId,
        userId: mcpTokens.userId,
        tokenHash: mcpTokens.tokenHash,
        expiresAt: mcpTokens.expiresAt,
        lastUsedAt: mcpTokens.lastUsedAt,
        revokedAt: mcpTokens.revokedAt,
        createdAt: mcpTokens.createdAt,
      })
      .from(mcpTokens)
      .where(and(eq(mcpTokens.orgId, parsed.orgId), eq(mcpTokens.tokenHash, hash))),
  );
  if (!row || row.revokedAt || row.expiresAt <= now) return null;
  // Equal by construction (looked up by hash); compared again in constant time all the same.
  if (!timingSafeEqual(Buffer.from(row.tokenHash), Buffer.from(hash))) return null;
  // The CURRENT membership and role: a removed member's token stops at once, and a token issued
  // during an earlier membership (removed, then invited again) never works again.
  const current = await membership(deps.db, row.orgId, row.userId);
  if (!current) return null;
  if (row.createdAt < current.since) {
    await withOrg(deps.db, row.orgId, (tx) =>
      revokeEarlierMembershipTokens(tx, row.orgId, row.userId, current.since),
    );
    return null;
  }
  const roles = current.roles;
  if (await mcpAccessProblem(deps, row.orgId, roles)) return null;
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS) {
    await withOrg(deps.db, row.orgId, (tx) =>
      tx.update(mcpTokens).set({ lastUsedAt: now }).where(eq(mcpTokens.id, row.id)),
    );
  }
  return { tokenId: row.id, orgId: row.orgId, userId: row.userId, roles };
}
