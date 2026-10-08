'use server';

import { ForbiddenError } from '@agile/connections';
import { discoverBoards, requestSync, saveStatusMappings, setBoardSelection } from '@agile/sync';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { formData, uuid } from '@/server/action-input';
import { entitlements } from '@/server/billing';
import { requireActor, services } from '@/server/context';
import { syncDeps, syncQueue } from '@/server/sync';

export type ActionState =
  | { status: 'idle' }
  | { status: 'ok'; queued?: boolean }
  | { status: 'error'; code: string };

const path = (connectionId: string) => `/settings/jira/${connectionId}`;
const invalidInput: ActionState = { status: 'error', code: 'invalid_input' };

async function guarded(run: () => Promise<ActionState>): Promise<ActionState> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ForbiddenError) return { status: 'error', code: 'forbidden_role' };
    throw e;
  }
}

export async function discoverBoardsAction(connectionId: unknown): Promise<ActionState> {
  const actor = await requireActor();
  const id = uuid.safeParse(connectionId);
  if (!id.success) return { status: 'error', code: 'not_found' };
  return guarded(async () => {
    const result = await discoverBoards(syncDeps(), actor, id.data);
    if (!result.ok) return { status: 'error', code: result.code };
    revalidatePath(path(id.data));
    return { status: 'ok' };
  });
}

export async function saveBoardSelectionAction(
  connectionId: unknown,
  _prev: ActionState,
  form: unknown,
): Promise<ActionState> {
  const actor = await requireActor();
  const parsed = z.tuple([uuid, formData]).safeParse([connectionId, form]);
  if (!parsed.success) return invalidInput;
  const [id, data] = parsed.data;
  const ids = z.array(uuid).max(500).safeParse(data.getAll('board'));
  if (!ids.success) return invalidInput;
  return guarded(async () => {
    // SaaS plans limit synced boards (a quota checked when boards are added; never removes).
    const { maxBoards } = await entitlements(actor.orgId);
    const result = await setBoardSelection(syncDeps(), actor, id, ids.data, {
      maxSelectedBoards: maxBoards,
    });
    if (!result.ok) return { status: 'error', code: result.code };
    revalidatePath(path(id));
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
  connectionId: unknown,
  boardId: unknown,
  _prev: ActionState,
  form: unknown,
): Promise<ActionState> {
  const actor = await requireActor();
  const parsed = z.tuple([uuid, uuid, formData]).safeParse([connectionId, boardId, form]);
  if (!parsed.success) return invalidInput;
  const [id, board, data] = parsed.data;
  const entries = z
    .array(mappingEntry)
    .min(1)
    .max(300)
    .safeParse(
      data.getAll('status').map((status) => ({
        jiraStatusId: status,
        category: data.get(`category:${status}`),
        blocked: data.get(`blocked:${status}`) === 'on',
      })),
    );
  if (!entries.success) return invalidInput;
  return guarded(async () => {
    const result = await saveStatusMappings(syncDeps(), actor, board, entries.data);
    if (!result.ok) return { status: 'error', code: result.code };
    revalidatePath(path(id));
    return { status: 'ok' };
  });
}

export async function requestSyncAction(connectionId: unknown): Promise<ActionState> {
  const actor = await requireActor();
  const id = uuid.safeParse(connectionId);
  if (!id.success) return { status: 'error', code: 'not_found' };
  return guarded(async () => {
    const result = await requestSync(
      { db: services().db, boss: await syncQueue() },
      actor,
      id.data,
    );
    if (!result.ok) return { status: 'error', code: result.code };
    revalidatePath(path(id.data));
    return { status: 'ok', queued: result.queued };
  });
}
