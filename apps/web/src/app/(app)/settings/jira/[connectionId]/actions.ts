'use server';

import { ForbiddenError } from '@agile/connections';
import { discoverBoards, requestSync, saveStatusMappings, setBoardSelection } from '@agile/sync';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireActor, services } from '@/server/context';
import { syncDeps, syncQueue } from '@/server/sync';

export type ActionState =
  | { status: 'idle' }
  | { status: 'ok'; queued?: boolean }
  | { status: 'error'; code: string };

const uuid = z.uuid();
const path = (connectionId: string) => `/settings/jira/${connectionId}`;

async function guarded(run: () => Promise<ActionState>): Promise<ActionState> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ForbiddenError) return { status: 'error', code: 'forbidden_role' };
    throw e;
  }
}

export async function discoverBoardsAction(connectionId: string): Promise<ActionState> {
  const actor = await requireActor();
  if (!uuid.safeParse(connectionId).success) return { status: 'error', code: 'not_found' };
  return guarded(async () => {
    const result = await discoverBoards(syncDeps(), actor, connectionId);
    if (!result.ok) return { status: 'error', code: result.code };
    revalidatePath(path(connectionId));
    return { status: 'ok' };
  });
}

export async function saveBoardSelectionAction(
  connectionId: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  const ids = z.array(uuid).max(500).safeParse(form.getAll('board'));
  if (!uuid.safeParse(connectionId).success || !ids.success) {
    return { status: 'error', code: 'invalid_input' };
  }
  return guarded(async () => {
    const result = await setBoardSelection(syncDeps(), actor, connectionId, ids.data);
    if (!result.ok) return { status: 'error', code: result.code };
    revalidatePath(path(connectionId));
    revalidatePath('/');
    return { status: 'ok' };
  });
}

const mappingEntry = z.object({
  jiraStatusId: z.string().min(1).max(64),
  category: z.enum(['todo', 'in_progress', 'done']),
  blocked: z.boolean(),
});

export async function saveStatusMappingAction(
  connectionId: string,
  boardId: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  const entries = z
    .array(mappingEntry)
    .min(1)
    .max(300)
    .safeParse(
      form.getAll('status').map((id) => ({
        jiraStatusId: id,
        category: form.get(`category:${id}`),
        blocked: form.get(`blocked:${id}`) === 'on',
      })),
    );
  if (!uuid.safeParse(boardId).success || !entries.success) {
    return { status: 'error', code: 'invalid_input' };
  }
  return guarded(async () => {
    const result = await saveStatusMappings(syncDeps(), actor, boardId, entries.data);
    if (!result.ok) return { status: 'error', code: result.code };
    revalidatePath(path(connectionId));
    return { status: 'ok' };
  });
}

export async function requestSyncAction(connectionId: string): Promise<ActionState> {
  const actor = await requireActor();
  if (!uuid.safeParse(connectionId).success) return { status: 'error', code: 'not_found' };
  return guarded(async () => {
    const result = await requestSync(
      { db: services().db, boss: await syncQueue() },
      actor,
      connectionId,
    );
    if (!result.ok) return { status: 'error', code: result.code };
    revalidatePath(path(connectionId));
    return { status: 'ok', queued: result.queued };
  });
}
