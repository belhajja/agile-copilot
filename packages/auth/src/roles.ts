import { type Db, member } from '@agile/db';
import { and, eq } from 'drizzle-orm';

/** better-auth stores multiple roles as a comma-separated string. */
export async function getMemberRoles(db: Db, orgId: string, userId: string): Promise<string[]> {
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1);
  return row
    ? row.role
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean)
    : [];
}

export function canManageConnections(roles: readonly string[]): boolean {
  return roles.includes('owner') || roles.includes('admin');
}
