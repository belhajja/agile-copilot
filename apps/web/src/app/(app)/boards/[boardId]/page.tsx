import {
  computeWidget,
  ensureDefaultDashboards,
  listDashboards,
  loadBoardDataset,
} from '@agile/dashboards';
import { getBoard } from '@agile/sync';
import { RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { DashboardView } from '@/components/dashboard/dashboard-view';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { requireActor, services } from '@/server/context';
import { syncDeps } from '@/server/sync';

export default async function BoardDashboardPage({
  params,
}: {
  params: Promise<{ boardId: string }>;
}) {
  const actor = await requireActor();
  const { boardId } = await params;
  if (!z.uuid().safeParse(boardId).success) notFound();
  const board = await getBoard(syncDeps(), actor.orgId, boardId);
  if (!board?.selected) notFound();

  const { db } = services();
  const t = await getTranslations('dashboards');
  const format = await getFormatter();
  await ensureDefaultDashboards(db, actor.orgId, actor.userId, board);
  const [dashboards, dataset] = await Promise.all([
    listDashboards(db, actor.orgId, actor.userId, board.id),
    loadBoardDataset(db, actor.orgId, board.id),
  ]);
  const now = new Date();

  const header = (
    <div className="grid gap-1">
      <h1 className="text-2xl font-semibold tracking-tight">{board.name}</h1>
      <p className="text-muted-foreground">
        {board.lastSyncedAt
          ? t('lastSynced', { when: format.relativeTime(board.lastSyncedAt, now) })
          : t('neverSynced')}
      </p>
    </div>
  );

  if (!dataset || dataset.issues.length === 0) {
    return (
      <div className="grid gap-6">
        {header}
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RefreshCw />
            </EmptyMedia>
            <EmptyTitle>{t('noData')}</EmptyTitle>
            <EmptyDescription>{t('noDataHint')}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild variant="outline">
              <Link href={`/settings/jira/${board.connectionId}`}>{t('openSettings')}</Link>
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  const views = dashboards.map((d) => ({
    id: d.id,
    label: d.kind === 'custom' ? d.name : t(`kinds.${d.kind}`),
    widgets: d.widgets.map((spec) => ({ spec, data: computeWidget(spec, dataset, now) })),
  }));
  return (
    <div className="grid gap-6">
      {header}
      <Tabs defaultValue={views[0]?.id}>
        <TabsList>
          {views.map((v) => (
            <TabsTrigger key={v.id} value={v.id}>
              {v.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {views.map((v) => (
          <TabsContent key={v.id} value={v.id} className="mt-4">
            <DashboardView widgets={v.widgets} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
