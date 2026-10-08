import { agentConversationGroups, agentConversations, type Db, isUuid, withOrg } from '@agile/db';
import { and, desc, eq, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import type { ConversationSummary } from './conversations';
import type { AgentActor } from './deps';
import { GROUP_NAME_MAX_LENGTH } from './limits';

/** Groups one person can have in a workspace. */
export const MAX_GROUPS = 50;
/** Recent ungrouped conversations listed in the sidebar. */
export const RECENT_LIMIT = 30;
/** Conversations listed per group, and archived conversations listed. */
export const SECTION_LIMIT = 100;

const cleanName = (name: string) =>
  name.replace(/\s+/g, ' ').trim().slice(0, GROUP_NAME_MAX_LENGTH);

const ownGroup = (actor: AgentActor, id: string) =>
  and(
    eq(agentConversationGroups.id, id),
    eq(agentConversationGroups.orgId, actor.orgId),
    eq(agentConversationGroups.userId, actor.userId),
  );

const ownConversations = (actor: AgentActor) =>
  and(
    eq(agentConversations.orgId, actor.orgId),
    eq(agentConversations.userId, actor.userId),
    // Untitled conversations have no question yet: nothing worth listing.
    ne(agentConversations.title, ''),
  );

export async function createGroup(
  db: Db,
  actor: AgentActor,
  name: string,
): Promise<{ ok: true; id: string } | { ok: false; code: 'invalid_name' | 'too_many' }> {
  const clean = cleanName(name);
  if (!clean) return { ok: false, code: 'invalid_name' };
  return withOrg(db, actor.orgId, async (tx) => {
    // One person's groups are counted under a lock on that person: two tabs cannot both pass.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`agent_groups:${actor.orgId}:${actor.userId}`}))`,
    );
    const count = await tx.$count(
      agentConversationGroups,
      and(
        eq(agentConversationGroups.orgId, actor.orgId),
        eq(agentConversationGroups.userId, actor.userId),
      ),
    );
    if (count >= MAX_GROUPS) return { ok: false, code: 'too_many' } as const;
    const [row] = await tx
      .insert(agentConversationGroups)
      .values({ orgId: actor.orgId, userId: actor.userId, name: clean })
      .returning({ id: agentConversationGroups.id });
    return { ok: true, id: row?.id ?? '' } as const;
  });
}

/** False when the group is not the user's or the name is blank. */
export async function renameGroup(
  db: Db,
  actor: AgentActor,
  id: string,
  name: string,
): Promise<boolean> {
  const clean = cleanName(name);
  if (!clean || !isUuid(id)) return false;
  const rows = await withOrg(db, actor.orgId, (tx) =>
    tx
      .update(agentConversationGroups)
      .set({ name: clean })
      .where(ownGroup(actor, id))
      .returning({ id: agentConversationGroups.id }),
  );
  return rows.length > 0;
}

/** Deletes one of the user's groups; its conversations go back to the ungrouped list. */
export async function deleteGroup(db: Db, actor: AgentActor, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await withOrg(db, actor.orgId, (tx) =>
    tx
      .delete(agentConversationGroups)
      .where(ownGroup(actor, id))
      .returning({ id: agentConversationGroups.id }),
  );
  return rows.length > 0;
}

/**
 * Files one of the user's conversations in one of their groups (null = out of any group). The
 * group is checked here: the foreign key alone would accept someone else's.
 */
export async function moveConversationToGroup(
  db: Db,
  actor: AgentActor,
  conversationId: string,
  groupId: string | null,
): Promise<boolean> {
  if (!isUuid(conversationId) || (groupId !== null && !isUuid(groupId))) return false;
  return withOrg(db, actor.orgId, async (tx) => {
    if (groupId !== null) {
      const [group] = await tx
        .select({ id: agentConversationGroups.id })
        .from(agentConversationGroups)
        .where(ownGroup(actor, groupId))
        .for('share');
      if (!group) return false;
    }
    const rows = await tx
      .update(agentConversations)
      .set({ groupId, updatedAt: sql`${agentConversations.updatedAt}` })
      .where(
        and(
          eq(agentConversations.id, conversationId),
          eq(agentConversations.orgId, actor.orgId),
          eq(agentConversations.userId, actor.userId),
        ),
      )
      .returning({ id: agentConversations.id });
    return rows.length > 0;
  });
}

export interface HistoryGroupSummary {
  id: string;
  name: string;
  conversations: ConversationSummary[];
}

export interface ConversationHistory {
  /** The user's groups, the most recently active first (then the newest). */
  groups: HistoryGroupSummary[];
  /** Ungrouped, not archived, most recent first. */
  recent: ConversationSummary[];
  /** Archived (in a group or not), most recently archived first. */
  archived: ConversationSummary[];
}

const summary = {
  id: agentConversations.id,
  title: agentConversations.title,
  updatedAt: agentConversations.updatedAt,
};

/** What the assistant's sidebar lists for the user. */
export async function listConversationHistory(
  db: Db,
  actor: AgentActor,
): Promise<ConversationHistory> {
  return withOrg(db, actor.orgId, async (tx) => {
    const groups = await tx
      .select({
        id: agentConversationGroups.id,
        name: agentConversationGroups.name,
        createdAt: agentConversationGroups.createdAt,
      })
      .from(agentConversationGroups)
      .where(
        and(
          eq(agentConversationGroups.orgId, actor.orgId),
          eq(agentConversationGroups.userId, actor.userId),
        ),
      )
      .orderBy(desc(agentConversationGroups.createdAt));
    // Per group, its latest conversations (one windowed query, not one per group).
    const ranked = tx
      .select({
        ...summary,
        groupId: agentConversations.groupId,
        rank: sql<number>`row_number() over (partition by ${agentConversations.groupId} order by ${agentConversations.updatedAt} desc)`.as(
          'rank',
        ),
      })
      .from(agentConversations)
      .where(
        and(
          ownConversations(actor),
          isNotNull(agentConversations.groupId),
          isNull(agentConversations.archivedAt),
        ),
      )
      .as('ranked');
    const grouped = await tx
      .select({
        id: ranked.id,
        title: ranked.title,
        updatedAt: ranked.updatedAt,
        groupId: ranked.groupId,
      })
      .from(ranked)
      .where(lte(ranked.rank, SECTION_LIMIT))
      .orderBy(desc(ranked.updatedAt));
    const recent = await tx
      .select(summary)
      .from(agentConversations)
      .where(
        and(
          ownConversations(actor),
          isNull(agentConversations.groupId),
          isNull(agentConversations.archivedAt),
        ),
      )
      .orderBy(desc(agentConversations.updatedAt))
      .limit(RECENT_LIMIT);
    const archived = await tx
      .select(summary)
      .from(agentConversations)
      .where(and(ownConversations(actor), isNotNull(agentConversations.archivedAt)))
      .orderBy(desc(agentConversations.archivedAt))
      .limit(SECTION_LIMIT);
    const byGroup = new Map<string, ConversationSummary[]>();
    for (const { groupId, ...c } of grouped) {
      if (groupId) byGroup.set(groupId, [...(byGroup.get(groupId) ?? []), c]);
    }
    const lastActive = (g: { id: string; createdAt: Date }) =>
      byGroup.get(g.id)?.[0]?.updatedAt ?? g.createdAt;
    return {
      groups: [...groups]
        .sort((a, b) => lastActive(b).getTime() - lastActive(a).getTime())
        .map((g) => ({ id: g.id, name: g.name, conversations: byGroup.get(g.id) ?? [] })),
      recent,
      archived,
    };
  });
}
