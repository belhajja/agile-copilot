import { canManageConnections } from '@agile/auth';
import { ForbiddenError } from './errors';

export interface Actor {
  orgId: string;
  userId: string;
  roles: readonly string[];
}

export function assertCanManage(actor: Actor): void {
  if (!canManageConnections(actor.roles)) {
    throw new ForbiddenError('Only workspace owners and admins can manage connections');
  }
}
