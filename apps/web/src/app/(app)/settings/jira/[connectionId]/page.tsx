import { canManageConnections } from '@agile/auth';
import { listJiraConnections } from '@agile/connections';
import { getSyncState, listBoards, listStatusMappings } from '@agile/sync';
import { LayoutGrid } from 'lucide-react';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { SettingsPage } from '@/components/settings/settings-page';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { allowedCode } from '@/lib/error-code';
import { connectionDeps, requireActor } from '@/server/context';
import { syncDeps } from '@/server/sync';
import { BOARD_ERROR_CODES } from '../error-codes';
import { BoardSelectionForm } from './board-selection-form';
import { StatusMappingForm } from './status-mapping-form';
import { DiscoverBoardsButton, SyncControls } from './sync-controls';

export default async function JiraConnectionBoardsPage({
  params,
}: {
  params: Promise<{ connectionId: string }>;
}) {
  const actor = await requireActor();
  const { connectionId } = await params;
  if (!z.uuid().safeParse(connectionId).success) notFound();
  const connection = (await listJiraConnections(connectionDeps(), actor.orgId)).find(
    (c) => c.id === connectionId,
  );
  if (!connection) notFound();

  const t = await getTranslations('boards');
  const format = await getFormatter();
  const deps = syncDeps();
  const canManage = canManageConnections(actor.roles);
  const [boards, state] = await Promise.all([
    listBoards(deps, actor.orgId, connectionId),
    getSyncState(deps, actor.orgId, connectionId),
  ]);
  const selected = boards.filter((b) => b.selected);
  const syncLabel =
    state.status === 'ok' && state.lastSuccessAt
      ? t('sync.ok', { when: format.relativeTime(state.lastSuccessAt, new Date()) })
      : t(`sync.${state.status}`);
  const syncError =
    state.status === 'error' && state.lastError
      ? t(`errors.${allowedCode(state.lastError, BOARD_ERROR_CODES) ?? 'unknown'}`)
      : null;
  const mappings = await Promise.all(
    selected.map(async (b) => ({
      board: b,
      rows: await listStatusMappings(deps, actor.orgId, b.id),
    })),
  );

  return (
    <SettingsPage
      title={connection.name}
      description={t('description')}
      actions={
        boards.length > 0 &&
        canManage && <DiscoverBoardsButton connectionId={connectionId} label={t('refresh')} />
      }
    >
      <SyncControls
        connectionId={connectionId}
        status={state.status}
        label={syncLabel}
        error={syncError}
        canManage={canManage}
        hasSelection={selected.length > 0}
      />
      {boards.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutGrid />
            </EmptyMedia>
            <EmptyTitle>{t('empty')}</EmptyTitle>
            <EmptyDescription>{t('emptyHint')}</EmptyDescription>
          </EmptyHeader>
          {canManage && (
            <EmptyContent>
              <DiscoverBoardsButton
                connectionId={connectionId}
                label={t('load')}
                variant="default"
              />
            </EmptyContent>
          )}
        </Empty>
      ) : (
        // The forms keep their own state after saving (it already matches what was stored), so they
        // are not remounted: a remount would also drop the "saved" toast.
        <BoardSelectionForm connectionId={connectionId} boards={boards} canManage={canManage} />
      )}
      {mappings.map(({ board, rows }) => (
        <StatusMappingForm
          key={board.id}
          connectionId={connectionId}
          boardId={board.id}
          boardName={board.name}
          mappings={rows}
          canManage={canManage}
        />
      ))}
    </SettingsPage>
  );
}
