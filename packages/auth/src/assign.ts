import { APIError } from 'better-auth/api';
import { isRole, type Role } from './role-matrix';

/** Error code a client sees when it tries to give a role outside the four (e.g. `member`). */
export const ROLE_NOT_ALLOWED = 'ROLE_NOT_ALLOWED';

/**
 * Exactly one of our roles, compared as sent: no trimming, no comma lists, no arrays. better-auth
 * also accepts its built-in `member` and lists, and its owner checks compare untrimmed strings
 * (so `' owner'` would pass them while our matrix reads it as `owner`); all of these are refused.
 */
export function assertAssignableRole(role: unknown): Role {
  if (!isRole(role)) {
    throw new APIError('BAD_REQUEST', {
      code: ROLE_NOT_ALLOWED,
      message: 'Choose one of: owner, admin, manager, viewer.',
    });
  }
  return role;
}
