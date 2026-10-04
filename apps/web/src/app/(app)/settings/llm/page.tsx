import { canManageConnections } from '@agile/auth';
import { listLlmConnections } from '@agile/connections';
import { Bot } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { ItemGroup } from '@/components/ui/item';
import { connectionDeps, requireActor } from '@/server/context';
import { LlmConnectionForm } from './llm-connection-form';
import { LlmConnectionItem } from './llm-connection-item';

export default async function LlmSettingsPage() {
  const actor = await requireActor();
  const t = await getTranslations('llm');
  const connections = await listLlmConnections(connectionDeps(), actor.orgId);
  const canManage = canManageConnections(actor.roles);
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground">{t('intro')}</p>
      </div>
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
        <ItemGroup className="gap-3">
          {connections.map((c) => (
            <LlmConnectionItem key={c.id} c={c} canManage={canManage} />
          ))}
        </ItemGroup>
      )}
      {canManage ? (
        <LlmConnectionForm />
      ) : (
        <p className="text-sm text-muted-foreground">{t('readOnlyNotice')}</p>
      )}
    </div>
  );
}
