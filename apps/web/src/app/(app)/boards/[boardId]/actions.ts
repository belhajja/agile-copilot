'use server';

import { removeWidget, updateWidget, WIDGET_CHARTS } from '@agile/dashboards';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { uuid } from '@/server/action-input';
import { requireActor, services } from '@/server/context';

const widgetKey = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/**
 * Removes a widget from one of the user's own dashboards (bound to the board and dashboard). A
 * refusal is never silent: the page is reloaded with a translated `?error=` code.
 */
export async function removeWidgetAction(
  boardId: unknown,
  dashboardId: unknown,
  widgetId: unknown,
): Promise<void> {
  const actor = await requireActor();
  const parsedBoard = uuid.safeParse(boardId);
  if (!parsedBoard.success) notFound();
  const board = parsedBoard.data;
  const parsed = z.tuple([uuid, widgetKey]).safeParse([dashboardId, widgetId]);
  if (!parsed.success) redirect(`/boards/${board}?error=not_found`);
  const result = await removeWidget(services().db, actor, ...parsed.data);
  if (!result.ok) redirect(`/boards/${board}?error=${result.code}`);
  revalidatePath(`/boards/${board}`);
}

export type UpdateWidgetActionResult =
  | { ok: true }
  | { ok: false; code: 'not_found' | 'invalid_widget' | 'unknown' };

const updateInput = z.object({
  boardId: uuid,
  dashboardId: uuid,
  widgetId: widgetKey,
  changes: z
    .strictObject({
      title: z.string().max(200).nullable().optional(),
      chart: z.enum(WIDGET_CHARTS).optional(),
    })
    .refine((c) => c.title !== undefined || c.chart !== undefined),
});

/** Renames a widget of one of the user's dashboards and/or changes its chart. */
export async function updateWidgetAction(
  boardId: string,
  dashboardId: string,
  widgetId: string,
  changes: { title?: string | null; chart?: string },
): Promise<UpdateWidgetActionResult> {
  const actor = await requireActor();
  const parsed = updateInput.safeParse({ boardId, dashboardId, widgetId, changes });
  if (!parsed.success) return { ok: false, code: 'invalid_widget' };
  try {
    const result = await updateWidget(
      services().db,
      actor,
      parsed.data.dashboardId,
      parsed.data.widgetId,
      parsed.data.changes,
    );
    if (!result.ok) return result;
    revalidatePath(`/boards/${parsed.data.boardId}`);
    return { ok: true };
  } catch {
    return { ok: false, code: 'unknown' };
  }
}
