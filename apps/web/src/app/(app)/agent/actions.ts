'use server';

import {
  createGroup,
  deleteConversation,
  deleteGroup,
  GROUP_NAME_MAX_LENGTH,
  moveConversationToGroup,
  renameConversation,
  renameGroup,
  setConversationArchived,
  setConversationModel,
  TITLE_MAX_LENGTH,
} from '@agile/agent';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireActor, services } from '@/server/context';

export type ConversationActionResult =
  | { ok: true }
  | {
      ok: false;
      code: 'invalid' | 'not_found' | 'turn_in_progress' | 'too_many' | 'unknown_model';
    };

const id = z.uuid();
const title = z.string().trim().min(1).max(TITLE_MAX_LENGTH);
const groupName = z.string().trim().min(1).max(GROUP_NAME_MAX_LENGTH);

const invalid = { ok: false, code: 'invalid' } as const;
const notFound = { ok: false, code: 'not_found' } as const;

/** Every change shows in the sidebar of whichever conversation is open. */
const done = (ok: boolean): ConversationActionResult => {
  revalidatePath('/agent', 'layout');
  return ok ? { ok: true } : notFound;
};

export async function renameConversationAction(
  conversationId: unknown,
  value: unknown,
): Promise<ConversationActionResult> {
  const parsed = z.tuple([id, title]).safeParse([conversationId, value]);
  if (!parsed.success) return invalid;
  const actor = await requireActor();
  return done(await renameConversation(services().db, actor, ...parsed.data));
}

export async function archiveConversationAction(
  conversationId: unknown,
  archived: unknown,
): Promise<ConversationActionResult> {
  const parsed = z.tuple([id, z.boolean()]).safeParse([conversationId, archived]);
  if (!parsed.success) return invalid;
  const actor = await requireActor();
  return done(await setConversationArchived(services().db, actor, ...parsed.data));
}

export async function deleteConversationAction(
  conversationId: unknown,
): Promise<ConversationActionResult> {
  const parsed = id.safeParse(conversationId);
  if (!parsed.success) return invalid;
  const actor = await requireActor();
  const result = await deleteConversation(services().db, actor, parsed.data);
  if (result === 'turn_in_progress') return { ok: false, code: 'turn_in_progress' };
  return done(result === 'deleted');
}

export async function setConversationModelAction(
  conversationId: unknown,
  llmConnectionId: unknown,
): Promise<ConversationActionResult> {
  const parsed = z.tuple([id, id.nullable()]).safeParse([conversationId, llmConnectionId]);
  if (!parsed.success) return invalid;
  const actor = await requireActor();
  const result = await setConversationModel(services().db, actor, ...parsed.data);
  if (result === 'unknown_model') return { ok: false, code: 'unknown_model' };
  return done(result === 'ok');
}

export async function moveConversationAction(
  conversationId: unknown,
  groupId: unknown,
): Promise<ConversationActionResult> {
  const parsed = z.tuple([id, id.nullable()]).safeParse([conversationId, groupId]);
  if (!parsed.success) return invalid;
  const actor = await requireActor();
  return done(await moveConversationToGroup(services().db, actor, ...parsed.data));
}

/** Creates a group, and files the conversation in it when one is given. */
export async function createGroupAction(
  name: unknown,
  conversationId?: unknown,
): Promise<ConversationActionResult> {
  const parsed = z.tuple([groupName, id.optional()]).safeParse([name, conversationId]);
  if (!parsed.success) return invalid;
  const actor = await requireActor();
  const [clean, toFile] = parsed.data;
  const created = await createGroup(services().db, actor, clean);
  if (!created.ok) {
    return { ok: false, code: created.code === 'too_many' ? 'too_many' : 'invalid' };
  }
  if (toFile) await moveConversationToGroup(services().db, actor, toFile, created.id);
  return done(true);
}

export async function renameGroupAction(
  groupId: unknown,
  name: unknown,
): Promise<ConversationActionResult> {
  const parsed = z.tuple([id, groupName]).safeParse([groupId, name]);
  if (!parsed.success) return invalid;
  const actor = await requireActor();
  return done(await renameGroup(services().db, actor, ...parsed.data));
}

export async function deleteGroupAction(groupId: unknown): Promise<ConversationActionResult> {
  const parsed = id.safeParse(groupId);
  if (!parsed.success) return invalid;
  const actor = await requireActor();
  return done(await deleteGroup(services().db, actor, parsed.data));
}
