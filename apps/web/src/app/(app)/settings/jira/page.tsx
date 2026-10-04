import { canManageConnections } from '@agile/auth';
import { listJiraConnections } from '@agile/connections';
import { PlugZap } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { ItemGroup } from '@/components/ui/item';
import { connectionDeps, requireActor, services } from '@/server/context';
import { JiraConnectionForm } from './jira-connection-form';
import { JiraConnectionItem } from './jira-connection-item';

export default async function JiraSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const actor = await requireActor();
  const t = await getTranslations('jira');
  const { connected, error } = await searchParams;
  const connections = await listJiraConnections(connectionDeps(), actor.orgId);
  const canManage = canManageConnections(actor.roles);

  return (
    <div className="mx-auto grid w-full max-w-4xl gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>
      {connected && (
        <Alert>
          <AlertDescription>{t('oauthConnected', { count: Number(connected) })}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {t.has(`errors.${error}`) ? t(`errors.${error}`) : t('errors.unknown')}
          </AlertDescription>
        </Alert>
      )}
      {connections.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PlugZap />
            </EmptyMedia>
            <EmptyTitle>{t('empty')}</EmptyTitle>
            <EmptyDescription>{t('emptyHint')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="gap-3">
          {connections.map((c) => (
            <JiraConnectionItem key={c.id} c={c} canManage={canManage} />
          ))}
        </ItemGroup>
      )}
      {canManage ? (
        <JiraConnectionForm oauthEnabled={Boolean(services().env.ATLASSIAN_OAUTH_CLIENT_ID)} />
      ) : (
        <p className="text-sm text-muted-foreground">{t('readOnlyNotice')}</p>
      )}
    </div>
  );
}
