// Pure and client-safe: the browser imports it (through `@agile/auth/client`) to show roles.

/** The workspace roles, most powerful first. A member has exactly one. */
export const ROLES = ['owner', 'admin', 'manager', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** Role given to people who join without a chosen role (and to Phase 1–4 `member` rows). */
export const DEFAULT_ROLE: Role = 'viewer';

/**
 * The role matrix: which roles hold each permission. The only place access decisions are made;
 * everything else asks `can(roles, permission)`. Unknown roles (including the legacy `member`)
 * hold nothing.
 */
export const PERMISSIONS = {
  /** Jira and LLM connections, boards, status mappings, prices, delivery channels. */
  'connections.manage': ['owner', 'admin'],
  /** Invite, change roles, remove members (only owners grant or remove the owner role). */
  'members.manage': ['owner', 'admin'],
  /** Retention, external MCP access and other workspace-wide settings. */
  'workspace.settings': ['owner', 'admin'],
  'audit.export': ['owner', 'admin'],
  /** Everyone's usage on the Usage page (others see their own). */
  'usage.view_all': ['owner', 'admin'],
  'billing.manage': ['owner'],
  'workspace.delete': ['owner'],
  /** Live Jira reads through the assistant and skill runs (the connection's credentials). */
  'jira.read': ['owner', 'admin', 'manager'],
  /** Propose Jira changes; each one still needs the user's approval in the chat. */
  'jira.write': ['owner', 'admin', 'manager'],
  /** Personal tokens for external MCP clients (read-only analytics), when the workspace allows it. */
  'mcp.token': ['owner', 'admin', 'manager', 'viewer'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function can(roles: readonly string[], permission: Permission): boolean {
  const allowed: readonly string[] = PERMISSIONS[permission];
  return roles.some((r) => allowed.includes(r));
}

/** The most powerful known role, or null (no known role: no access). */
export function primaryRole(roles: readonly string[]): Role | null {
  return ROLES.find((r) => roles.includes(r)) ?? null;
}

/** better-auth stores multiple roles as a comma-separated string. */
export function parseRoles(role: string): string[] {
  return role
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
}
