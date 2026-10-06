import {
  agentConversations,
  agentMessages,
  type Db,
  isUuid,
  llmConnections,
  type Tx,
  withOrg,
} from '@agile/db';
import type { UIMessage } from 'ai';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
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

/** Conversation ids are uuids the browser chooses: anything else is refused before any query. */
export const isConversationId = isUuid;

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

export interface LoadedConversation {
  id: string;
  title: string;
  messages: UIMessage[];
  /** The model picked for it; null = the workspace default. */
  llmConnectionId: string | null;
  groupId: string | null;
  archived: boolean;
}

/** The messages of one of the user's conversations; null when it is not theirs (or unknown). */
export async function loadConversation(
  db: Db,
  actor: AgentActor,
  id: string,
): Promise<LoadedConversation | null> {
  if (!isConversationId(id)) return null;
  return withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx.select().from(agentConversations).where(ownedBy(actor, id));
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      messages: await readMessages(tx, id),
      llmConnectionId: row.llmConnectionId,
      groupId: row.groupId,
      archived: row.archivedAt !== null,
    };
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
  return withOrg(db, actor.orgId, async (tx) => {
    // Two first messages racing on a new id both land here: the loser waits for the winner's
    // insert, does nothing, then finds the row. An id taken by someone else stays invisible.
    await tx
      .insert(agentConversations)
      .values({ id, orgId: actor.orgId, userId: actor.userId })
      .onConflictDoNothing();
    const [row] = await tx.select().from(agentConversations).where(ownedBy(actor, id));
    if (!row) return null; // the id belongs to someone else
    return { id, messages: await readMessages(tx, id) };
  });
}

/** How long a chat turn may hold its conversation before another turn can take it over. */
export const TURN_LEASE_SECONDS = 600;

/** Another turn of this conversation is still running. */
export class TurnInProgressError extends Error {
  override name = 'TurnInProgressError';
  readonly code = 'turn_in_progress';
  constructor() {
    super('Another reply is still in progress');
  }
}

/** The turn's lease was taken over (it ran past the lease): its reply is not stored. */
export class TurnLostError extends Error {
  override name = 'TurnLostError';
  readonly code = 'turn_lost';
  constructor() {
    super('The reply no longer holds its conversation');
  }
}

/**
 * Starts a chat turn inside the caller's tenant transaction: locks the actor's conversation, takes
 * its turn lease (or throws `TurnInProgressError` while another turn holds it) and only THEN reads
 * the history, so two turns never both start from the same history and overwrite each other.
 */
export async function beginTurn(
  tx: Tx,
  actor: AgentActor,
  id: string,
  turnId: string,
): Promise<UIMessage[]> {
  if (!isConversationId(id)) throw new ConversationNotFoundError();
  const [row] = await tx
    .select({
      busy: sql<boolean>`(${agentConversations.turnId} is not null and ${agentConversations.turnStartedAt} > now() - make_interval(secs => ${TURN_LEASE_SECONDS}))`,
    })
    .from(agentConversations)
    .where(ownedBy(actor, id))
    .for('update');
  if (!row) throw new ConversationNotFoundError();
  if (row.busy) throw new TurnInProgressError();
  await tx
    .update(agentConversations)
    .set({ turnId, turnStartedAt: sql`now()` })
    .where(ownedBy(actor, id));
  return readMessages(tx, id);
}

/**
 * Ends a chat turn inside the caller's transaction (before storing its reply there): throws
 * `TurnLostError` if the turn no longer holds the conversation, otherwise releases it.
 */
export async function endTurn(tx: Tx, actor: AgentActor, id: string, turnId: string) {
  const released = await tx
    .update(agentConversations)
    .set({ turnId: null, turnStartedAt: null })
    .where(and(ownedBy(actor, id), eq(agentConversations.turnId, turnId)))
    .returning({ id: agentConversations.id });
  if (released.length === 0) throw new TurnLostError();
}

/**
 * The stored history of a turn that still holds its conversation (locked in the caller's
 * transaction), or null when the lease was taken over: a failed turn repairs its history only
 * while no other turn can be writing it.
 */
export async function heldHistory(
  tx: Tx,
  actor: AgentActor,
  id: string,
  turnId: string,
): Promise<UIMessage[] | null> {
  const [row] = await tx
    .select({ turnId: agentConversations.turnId })
    .from(agentConversations)
    .where(ownedBy(actor, id))
    .for('update');
  return row?.turnId === turnId ? readMessages(tx, id) : null;
}

/** Whether the turn still holds its conversation (checked between model steps). */
export async function holdsTurn(
  db: Db,
  actor: AgentActor,
  id: string,
  turnId: string,
): Promise<boolean> {
  const [row] = await withOrg(db, actor.orgId, (tx) =>
    tx
      .select({ turnId: agentConversations.turnId })
      .from(agentConversations)
      .where(ownedBy(actor, id)),
  );
  return row?.turnId === turnId;
}

/** Best-effort release of a turn that ends without storing a reply (setup or storage failed). */
export async function releaseTurn(db: Db, actor: AgentActor, id: string, turnId: string) {
  await withOrg(db, actor.orgId, (tx) =>
    tx
      .update(agentConversations)
      .set({ turnId: null, turnStartedAt: null })
      .where(and(ownedBy(actor, id), eq(agentConversations.turnId, turnId))),
  );
}

const titleOf = (messages: UIMessage[]) => {
  const first = messages.find((m) => m.role === 'user');
  return cleanTitle(first?.parts.find((p) => p.type === 'text')?.text ?? '');
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

/** Longest title kept, typed or derived from the first question. */
export const TITLE_MAX_LENGTH = 80;

const cleanTitle = (title: string) => title.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX_LENGTH);

// Renaming, archiving or filing a conversation is not activity: its place by date stays.
const unchangedDate = { updatedAt: sql`${agentConversations.updatedAt}` };

/** Renames one of the user's conversations. False when it is not theirs or the title is blank. */
export async function renameConversation(
  db: Db,
  actor: AgentActor,
  id: string,
  title: string,
): Promise<boolean> {
  const clean = cleanTitle(title);
  if (!clean || !isConversationId(id)) return false;
  const rows = await withOrg(db, actor.orgId, (tx) =>
    tx
      .update(agentConversations)
      .set({ title: clean, ...unchangedDate })
      .where(ownedBy(actor, id))
      .returning({ id: agentConversations.id }),
  );
  return rows.length > 0;
}

/** Archives (or brings back) one of the user's conversations. False when it is not theirs. */
export async function setConversationArchived(
  db: Db,
  actor: AgentActor,
  id: string,
  archived: boolean,
): Promise<boolean> {
  if (!isConversationId(id)) return false;
  const rows = await withOrg(db, actor.orgId, (tx) =>
    tx
      .update(agentConversations)
      .set({ archivedAt: archived ? sql`now()` : null, ...unchangedDate })
      .where(ownedBy(actor, id))
      .returning({ id: agentConversations.id }),
  );
  return rows.length > 0;
}

/** A new question brings an archived conversation back (in the caller's transaction). */
export async function unarchiveConversation(tx: Tx, actor: AgentActor, id: string) {
  await tx
    .update(agentConversations)
    .set({ archivedAt: null })
    .where(and(ownedBy(actor, id), sql`${agentConversations.archivedAt} is not null`));
}

/**
 * Deletes one of the user's conversations with its messages and approvals (usage rows stay: they
 * carry the workspace's spend). Refused while a reply is being written.
 */
export async function deleteConversation(
  db: Db,
  actor: AgentActor,
  id: string,
): Promise<'deleted' | 'not_found' | 'turn_in_progress'> {
  if (!isConversationId(id)) return 'not_found';
  return withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx
      .select({
        busy: sql<boolean>`(${agentConversations.turnId} is not null and ${agentConversations.turnStartedAt} > now() - make_interval(secs => ${TURN_LEASE_SECONDS}))`,
      })
      .from(agentConversations)
      .where(ownedBy(actor, id))
      .for('update');
    if (!row) return 'not_found';
    if (row.busy) return 'turn_in_progress';
    await tx.delete(agentConversations).where(ownedBy(actor, id));
    return 'deleted';
  });
}

/**
 * Picks the model of one of the user's conversations (null = the workspace default), creating the
 * conversation under the client-chosen id when it is new. The model must be one of the workspace's
 * connections.
 */
export async function setConversationModel(
  db: Db,
  actor: AgentActor,
  id: string,
  llmConnectionId: string | null,
): Promise<'ok' | 'not_found' | 'unknown_model'> {
  if (!isConversationId(id)) return 'not_found';
  if (llmConnectionId !== null && !isUuid(llmConnectionId)) return 'unknown_model';
  return withOrg(db, actor.orgId, async (tx) => {
    if (llmConnectionId !== null) {
      // RLS shows only this workspace's connections (the foreign key alone would accept any).
      const [model] = await tx
        .select({ id: llmConnections.id })
        .from(llmConnections)
        .where(eq(llmConnections.id, llmConnectionId));
      if (!model) return 'unknown_model';
    }
    await tx
      .insert(agentConversations)
      .values({ id, orgId: actor.orgId, userId: actor.userId })
      .onConflictDoNothing();
    const rows = await tx
      .update(agentConversations)
      .set({ llmConnectionId, ...unchangedDate })
      .where(ownedBy(actor, id))
      .returning({ id: agentConversations.id });
    return rows.length > 0 ? 'ok' : 'not_found';
  });
}

/** The model picked for one of the user's conversations; null = the default (or not theirs). */
export async function conversationModelId(
  db: Db,
  actor: AgentActor,
  id: string,
): Promise<string | null> {
  if (!isConversationId(id)) return null;
  const [row] = await withOrg(db, actor.orgId, (tx) =>
    tx
      .select({ llmConnectionId: agentConversations.llmConnectionId })
      .from(agentConversations)
      .where(ownedBy(actor, id)),
  );
  return row?.llmConnectionId ?? null;
}
