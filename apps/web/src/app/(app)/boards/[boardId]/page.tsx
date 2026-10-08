import { insightsFor } from '@agile/automation';
import { listJiraConnections } from '@agile/connections';
import {
  bySprintDate,
  chartOptions,
  computeWidget,
  ensureDefaultDashboards,
  listDashboards,
  loadBoardDataset,
  PINNED_DASHBOARD_NAME,
  parseSprintSelection,
} from '@agile/dashboards';
import { getBoard } from '@agile/sync';
import { RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { AgentMarkdown } from '@/components/agent/agent-markdown';
import { DashboardView } from '@/components/dashboard/dashboard-view';
import { type SprintOption, SprintPicker } from '@/components/dashboard/sprint-picker';
import { JiraSiteProvider } from '@/components/jira-issue-link';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { pickCode } from '@/lib/error-code';
import { connectionDeps, requireActor, services } from '@/server/context';
import { syncDeps } from '@/server/sync';
import { removeWidgetAction, updateWidgetAction } from './actions';

const REMOVE_ERRORS = ['not_found', 'unknown'] as const;

export default async function BoardDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ boardId: string }>;
  searchParams: Promise<{ error?: string | string[]; sprints?: string | string[] }>;
}) {
  const actor = await requireActor();
  const { boardId } = await params;
  const { error, sprints: sprintsParam } = await searchParams;
  if (!z.uuid().safeParse(boardId).success) notFound();
  const board = await getBoard(syncDeps(), actor.orgId, boardId);
  if (!board?.selected) notFound();

  const { db } = services();
  const t = await getTranslations('dashboards');
  const format = await getFormatter();
  await ensureDefaultDashboards(db, actor.orgId, actor.userId, board);
  const [dashboards, dataset, insights, connections] = await Promise.all([
    listDashboards(db, actor.orgId, actor.userId, board.id),
    loadBoardDataset(db, actor.orgId, board.id),
    insightsFor(db, actor, board.id),
    listJiraConnections(connectionDeps(), actor.orgId),
  ]);
  const jiraBaseUrl = connections.find((c) => c.id === board.connectionId)?.baseUrl;
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

  const selected = parseSprintSelection(sprintsParam, dataset.sprints);
  const scope = selected.length > 0 ? { sprints: selected } : undefined;
  const range = (s: (typeof dataset.sprints)[number]) =>
    s.startAt
      ? format.dateTimeRange(s.startAt, s.completeAt ?? s.endAt ?? now, {
          day: 'numeric',
          month: 'short',
          timeZone: 'UTC',
        })
      : null;
  // Newest first, as list_sprints: future sprints, then by start date descending.
  const sprintOptions: SprintOption[] = [...dataset.sprints]
    .sort((a, b) => -bySprintDate(a, b))
    .map((s) => ({ id: s.id, name: s.name, state: s.state, dates: range(s) }));

  const views = dashboards.map((d) => {
    // Widgets pinned from the assistant can be renamed, re-charted or removed (Pinned only).
    const editable = d.kind === 'custom' && d.name === PINNED_DASHBOARD_NAME;
    return {
      id: d.id,
      label: d.kind !== 'custom' ? t(`kinds.${d.kind}`) : editable ? t('kinds.pinned') : d.name,
      widgets: d.widgets.map((spec) => ({
        spec,
        data: computeWidget(spec, dataset, now, scope),
        ...(editable ? { charts: chartOptions(spec) } : {}),
      })),
      editing: editable
        ? {
            remove: removeWidgetAction.bind(null, board.id, d.id),
            removeLabel: t('removeWidget'),
            update: updateWidgetAction.bind(null, board.id, d.id),
          }
        : undefined,
    };
  });
  return (
    <div className="grid gap-6">
      {header}
      {error !== undefined && (
        <Alert variant="destructive" data-error>
          <AlertDescription>{t(`removeErrors.${pickCode(error, REMOVE_ERRORS)}`)}</AlertDescription>
        </Alert>
      )}
      {insights.length > 0 && (
        <section className="grid gap-4 @3xl/main:grid-cols-2" aria-label={t('insights')}>
          {insights.map((i) => (
            <Card key={i.skillId} data-insight={i.name}>
              <CardHeader>
                <CardTitle className="break-words">{i.name}</CardTitle>
                <CardDescription>
                  {i.finishedAt
                    ? t('insightWhen', { when: format.relativeTime(i.finishedAt, now) })
                    : i.description}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <AgentMarkdown>{i.output}</AgentMarkdown>
              </CardContent>
            </Card>
          ))}
        </section>
      )}
      {sprintOptions.length > 0 && (
        <SprintPicker options={sprintOptions} selected={selected.map((s) => s.id)} />
      )}
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
            <JiraSiteProvider baseUrl={jiraBaseUrl}>
              <DashboardView widgets={v.widgets} editing={v.editing} />
            </JiraSiteProvider>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
