import { type Db, member } from '@agile/db';
import { and, eq } from 'drizzle-orm';
import { can, parseRoles } from './role-matrix';

export * from './role-matrix';

export async function getMemberRoles(db: Db, orgId: string, userId: string): Promise<string[]> {
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1);
  return row ? parseRoles(row.role) : [];
}

export function canManageConnections(roles: readonly string[]): boolean {
  return can(roles, 'connections.manage');
}
