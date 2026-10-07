import { canManageConnections } from '@agile/auth';
import { listLlmConnections } from '@agile/connections';
import { Bot } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { ConnectionList } from '@/components/settings/connection-card';
import { SettingsPage } from '@/components/settings/settings-page';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { connectionDeps, requireActor } from '@/server/context';
import { LlmConnectionForm } from './llm-connection-form';
import { LlmConnectionItem } from './llm-connection-item';

export default async function LlmSettingsPage() {
  const actor = await requireActor();
  const t = await getTranslations('llm');
  const connections = await listLlmConnections(connectionDeps(), actor.orgId);
  const canManage = canManageConnections(actor.roles);
  return (
    <SettingsPage title={t('title')} description={t('intro')}>
      {connections.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Bot />
            </EmptyMedia>
            <EmptyTitle>{t('empty')}</EmptyTitle>
            <EmptyDescription>{t('emptyHint')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ConnectionList>
          {connections.map((c) => (
            <LlmConnectionItem key={c.id} c={c} canManage={canManage} />
          ))}
        </ConnectionList>
      )}
      {canManage ? (
        <LlmConnectionForm />
      ) : (
        <p className="text-sm text-muted-foreground">{t('readOnlyNotice')}</p>
      )}
    </SettingsPage>
  );
}
