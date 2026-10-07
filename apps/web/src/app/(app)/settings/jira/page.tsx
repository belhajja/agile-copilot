import { canManageConnections } from '@agile/auth';
import { listJiraConnections } from '@agile/connections';
import { PlugZap } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { ConnectionList } from '@/components/settings/connection-card';
import { SettingsPage } from '@/components/settings/settings-page';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { pickCode } from '@/lib/error-code';
import { connectionDeps, requireActor, services } from '@/server/context';
import { JIRA_ERROR_CODES } from './error-codes';
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
    <SettingsPage title={t('title')} description={t('description')}>
      {connected && (
        <Alert>
          <AlertDescription>{t('oauthConnected', { count: Number(connected) })}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{t(`errors.${pickCode(error, JIRA_ERROR_CODES)}`)}</AlertDescription>
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
        <ConnectionList>
          {connections.map((c) => (
            <JiraConnectionItem key={c.id} c={c} canManage={canManage} />
          ))}
        </ConnectionList>
      )}
      {canManage ? (
        <JiraConnectionForm oauthEnabled={Boolean(services().env.ATLASSIAN_OAUTH_CLIENT_ID)} />
      ) : (
        <p className="text-sm text-muted-foreground">{t('readOnlyNotice')}</p>
      )}
    </SettingsPage>
  );
}
