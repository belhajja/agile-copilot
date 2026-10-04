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

/** Error code when a workspace's plan has no free seat (SaaS plans). */
export const SEAT_LIMIT_REACHED = 'SEAT_LIMIT_REACHED';

/**
 * Refuses one more seat when `used + 1` would exceed `limit` (null = no limit). A quota, not a
 * lock: two requests at the same moment may both pass (L11, accepted).
 */
export function assertSeatAvailable(limit: number | null, used: number): void {
  if (limit !== null && used + 1 > limit) {
    throw new APIError('FORBIDDEN', {
      code: SEAT_LIMIT_REACHED,
      message: 'This workspace has no free seat on its plan.',
    });
  }
}
