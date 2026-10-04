import {
  agentConversations,
  agentMessages,
  type Db,
  isUniqueViolation,
  type Tx,
  withOrg,
} from '@agile/db';
import type { UIMessage } from 'ai';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { AgentActor } from './deps';

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: Date;
}

/** The conversation is not the actor's (or does not exist). Never says which. */
export class ConversationNotFoundError extends Error {
  override name = 'ConversationNotFoundError';
  readonly code = 'not_found';
  constructor() {
    super('Conversation not found');
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isConversationId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

const ownedBy = (actor: AgentActor, id: string) =>
  and(
    eq(agentConversations.id, id),
    eq(agentConversations.orgId, actor.orgId),
    eq(agentConversations.userId, actor.userId),
  );

/**
 * Locks the actor's conversation inside the caller's tenant transaction, or throws. Every insert
 * of a message or an approval goes through this first: their foreign key only names the
 * conversation, and FK checks bypass RLS, so the database alone would accept rows pointing at
 * another user's (or another workspace's) conversation.
 */
export async function requireOwnConversation(
  tx: Tx,
  actor: AgentActor,
  id: string,
): Promise<{ title: string }> {
  if (!isConversationId(id)) throw new ConversationNotFoundError();
  const [row] = await tx
    .select({ title: agentConversations.title })
    .from(agentConversations)
    .where(ownedBy(actor, id))
    .for('update');
  if (!row) throw new ConversationNotFoundError();
  return row;
}

/** The user's own conversations, most recent first. */
export async function listConversations(
  db: Db,
  actor: AgentActor,
  limit = 30,
): Promise<ConversationSummary[]> {
  return withOrg(db, actor.orgId, (tx) =>
    tx
      .select({
        id: agentConversations.id,
        title: agentConversations.title,
        updatedAt: agentConversations.updatedAt,
      })
      .from(agentConversations)
      .where(
        and(eq(agentConversations.orgId, actor.orgId), eq(agentConversations.userId, actor.userId)),
      )
      .orderBy(desc(agentConversations.updatedAt))
      .limit(limit),
  );
}

async function readMessages(tx: Tx, conversationId: string): Promise<UIMessage[]> {
  const rows = await tx
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.conversationId, conversationId))
    .orderBy(asc(agentMessages.seq));
  return rows.map((r) => ({ id: r.id, role: r.role, parts: r.parts as UIMessage['parts'] }));
}

/** The messages of one of the user's conversations; null when it is not theirs (or unknown). */
export async function loadConversation(
  db: Db,
  actor: AgentActor,
  id: string,
): Promise<{ id: string; title: string; messages: UIMessage[] } | null> {
  if (!isConversationId(id)) return null;
  return withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx.select().from(agentConversations).where(ownedBy(actor, id));
    if (!row) return null;
    return { id: row.id, title: row.title, messages: await readMessages(tx, id) };
  });
}

/**
 * Opens the user's conversation, creating it under the client-chosen id on first use. An id that
 * exists anywhere else (another user, another workspace) is refused rather than revealed.
 */
export async function openOrCreateConversation(
  db: Db,
  actor: AgentActor,
  id: string,
): Promise<{ id: string; messages: UIMessage[] } | null> {
  if (!isConversationId(id)) return null;
  try {
    return await withOrg(db, actor.orgId, async (tx) => {
      const [row] = await tx.select().from(agentConversations).where(ownedBy(actor, id));
      if (row) return { id, messages: await readMessages(tx, id) };
      await tx.insert(agentConversations).values({ id, orgId: actor.orgId, userId: actor.userId });
      return { id, messages: [] };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return null; // the id belongs to someone else
    throw e;
  }
}

const titleOf = (messages: UIMessage[]) => {
  const first = messages.find((m) => m.role === 'user');
  const text = first?.parts.find((p) => p.type === 'text')?.text ?? '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 80);
};

/**
 * Replaces the stored messages of a conversation (the server is the only writer). Runs in the
 * caller's `withOrg` transaction; throws `ConversationNotFoundError` unless the actor owns it.
 */
export async function saveConversation(
  tx: Tx,
  actor: AgentActor,
  id: string,
  messages: UIMessage[],
): Promise<void> {
  const row = await requireOwnConversation(tx, actor, id);
  await tx.delete(agentMessages).where(eq(agentMessages.conversationId, id));
  const stored = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  if (stored.length > 0) {
    await tx.insert(agentMessages).values(
      stored.map((m, seq) => ({
        orgId: actor.orgId,
        conversationId: id,
        id: m.id,
        seq,
        role: m.role as 'user' | 'assistant',
        parts: m.parts,
      })),
    );
  }
  await tx
    .update(agentConversations)
    .set({ title: row.title || titleOf(stored), updatedAt: new Date() })
    .where(ownedBy(actor, id));
}
