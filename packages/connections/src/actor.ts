import { canManageConnections } from '@agile/auth';
import type { Actor } from '@agile/db';
import { ForbiddenError } from './errors';

export function assertCanManage(actor: Actor): void {
  if (!canManageConnections(actor.roles)) {
    throw new ForbiddenError('Only workspace owners and admins can manage connections');
  }
}
