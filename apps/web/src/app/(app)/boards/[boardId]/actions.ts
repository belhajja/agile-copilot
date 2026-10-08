'use server';

import { removeWidget, updateWidget, WIDGET_CHARTS } from '@agile/dashboards';
import { isUuid } from '@agile/db';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { requireActor, services } from '@/server/context';

/**
 * Removes a widget from one of the user's own dashboards (bound to the board and dashboard). A
 * refusal is never silent: the page is reloaded with a translated `?error=` code.
 */
export async function removeWidgetAction(
  boardId: string,
  dashboardId: string,
  widgetId: string,
): Promise<void> {
  const actor = await requireActor();
  if (!isUuid(boardId)) notFound();
  const result = await removeWidget(
    services().db,
    actor,
    dashboardId,
    String(widgetId).slice(0, 64),
  );
  if (!result.ok) redirect(`/boards/${boardId}?error=${result.code}`);
  revalidatePath(`/boards/${boardId}`);
}

export type UpdateWidgetActionResult =
  | { ok: true }
  | { ok: false; code: 'not_found' | 'invalid_widget' | 'unknown' };

const updateInput = z.object({
  boardId: z.uuid(),
  dashboardId: z.uuid(),
  widgetId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
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
