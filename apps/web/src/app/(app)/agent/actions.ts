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
import { pinWidget } from '@agile/dashboards';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
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
  if (!parsed.success) return notFound;
  const actor = await requireActor();
  return done(await setConversationArchived(services().db, actor, ...parsed.data));
}

/** `leave`: the deleted conversation is the open one, so the user goes to a new chat. */
export async function deleteConversationAction(
  conversationId: unknown,
  leave: unknown,
): Promise<ConversationActionResult> {
  const parsed = z.tuple([id, z.boolean()]).safeParse([conversationId, leave]);
  if (!parsed.success) return notFound;
  const actor = await requireActor();
  const result = await deleteConversation(services().db, actor, parsed.data[0]);
  if (result === 'turn_in_progress') return { ok: false, code: 'turn_in_progress' };
  const outcome = done(result === 'deleted');
  // Redirected from here: re-rendering the deleted conversation first would show a 404.
  if (outcome.ok && parsed.data[1]) redirect('/agent');
  return outcome;
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
  if (!parsed.success) return notFound;
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
  return done(!toFile || (await moveConversationToGroup(services().db, actor, toFile, created.id)));
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
  if (!parsed.success) return notFound;
  const actor = await requireActor();
  return done(await deleteGroup(services().db, actor, parsed.data));
}

export type PinResultActionResult =
  | { ok: true; boardId: string; alreadyPinned: boolean }
  | { ok: false; code: 'invalid_widget' | 'unknown_board' | 'dashboard_full' | 'unknown' };

const pinInput = z.object({ boardId: z.uuid(), widget: z.record(z.string(), z.unknown()) });

/** Pins a chat result to the user's "Pinned" dashboard of its board (same checks as the assistant's). */
export async function pinResultAction(input: {
  boardId: string;
  widget: unknown;
}): Promise<PinResultActionResult> {
  const actor = await requireActor();
  const parsed = pinInput.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'invalid_widget' };
  try {
    const result = await pinWidget(
      services().db,
      { orgId: actor.orgId, userId: actor.userId },
      { boardId: parsed.data.boardId, widget: parsed.data.widget, via: 'user' },
    );
    if (!result.ok) return { ok: false, code: result.code };
    if (!result.alreadyPinned) revalidatePath(`/boards/${parsed.data.boardId}`);
    return { ok: true, boardId: parsed.data.boardId, alreadyPinned: result.alreadyPinned };
  } catch {
    return { ok: false, code: 'unknown' };
  }
}
