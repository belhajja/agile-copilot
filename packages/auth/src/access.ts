import { createAccessControl } from 'better-auth/plugins/access';
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from 'better-auth/plugins/organization/access';
import type { Role } from './role-matrix';

// Client-safe: no database or server code, so `@agile/auth/client` can export it.

/**
 * better-auth's organisation permissions (members, invitations, the workspace itself) for our four
 * roles. Managers and viewers manage nobody. App permissions live in `PERMISSIONS`
 * (role-matrix.ts).
 */
export const ac = createAccessControl(defaultStatements);

export const orgRoles = {
  owner: ac.newRole(ownerAc.statements),
  admin: ac.newRole(adminAc.statements),
  manager: ac.newRole(memberAc.statements),
  viewer: ac.newRole(memberAc.statements),
} satisfies Record<Role, unknown>;
