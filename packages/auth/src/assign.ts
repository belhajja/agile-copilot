import { APIError } from 'better-auth/api';
import { isRole, parseRoles, type Role } from './role-matrix';

/** Error code a client sees when it tries to give a role outside the four (e.g. `member`). */
export const ROLE_NOT_ALLOWED = 'ROLE_NOT_ALLOWED';

/**
 * Exactly one of our roles. better-auth also accepts its built-in `member` and comma-separated
 * lists; both are refused here so the role set stays closed.
 */
export function assertAssignableRole(role: string): Role {
  const roles = parseRoles(role);
  const [only] = roles;
  if (roles.length !== 1 || !isRole(only)) {
    throw new APIError('BAD_REQUEST', {
      code: ROLE_NOT_ALLOWED,
      message: 'Choose one of: owner, admin, manager, viewer.',
    });
  }
  return only;
}
