// Pure and client-safe: the billing page shows these numbers.

/** What a workspace may use. `null` = no limit. */
export interface Entitlements {
  plan: PlanKey | 'selfhost';
  /** Members plus pending invitations. */
  maxSeats: number | null;
  /** Selected (synced) boards across all Jira connections. */
  maxBoards: number | null;
  /** Personal tokens for external MCP clients (Claude Desktop, …). */
  externalMcp: boolean;
}

export type PlanKey = 'free' | 'team';

/**
 * SaaS plans. Only what costs the service money or is a premium integration is limited: seats,
 * synced boards (sync and storage) and external MCP access. Security and privacy features (SSO,
 * audit export, retention, data export and deletion) are never paywalled.
 */
export const PLANS: Record<PlanKey, Entitlements> = {
  free: { plan: 'free', maxSeats: 3, maxBoards: 3, externalMcp: false },
  team: { plan: 'team', maxSeats: 25, maxBoards: 25, externalMcp: true },
};

/** Self-host builds: billing is off and nothing is limited. */
export const SELFHOST: Entitlements = {
  plan: 'selfhost',
  maxSeats: null,
  maxBoards: null,
  externalMcp: true,
};

/** Stripe statuses that keep the paid plan (past_due: Stripe is still retrying the payment). */
export const PAID_STATUSES = ['active', 'trialing', 'past_due'] as const;

export function entitlementsOf(sub: { plan: string | null; status: string | null } | null) {
  if (sub?.plan === 'team' && (PAID_STATUSES as readonly string[]).includes(sub.status ?? '')) {
    return PLANS.team;
  }
  return PLANS.free;
}

/** Whether `used + adding` stays within `limit` (null = unlimited). */
export const withinLimit = (limit: number | null, used: number, adding = 1) =>
  limit === null || used + adding <= limit;
