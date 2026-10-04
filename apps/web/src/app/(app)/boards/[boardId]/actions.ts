'use server';

import { removeWidget } from '@agile/dashboards';
import { isUuid } from '@agile/db';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
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
