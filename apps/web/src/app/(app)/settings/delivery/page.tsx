import { canManageConnections } from '@agile/auth';
import { listChannelUsage, listDeliveryChannels } from '@agile/notify';
import { Mail, MessageSquare, Send } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { ConnectionCard, ConnectionList } from '@/components/settings/connection-card';
import { SettingsPage } from '@/components/settings/settings-page';
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { requireActor, services } from '@/server/context';
import { ChannelForm } from './channel-form';
import { DeleteChannelButton } from './delete-channel-button';
import { isChannelErrorCode } from './error-codes';

/** Where skill reports go: the workspace's SMTP server and Slack/Teams webhooks. */
export default async function DeliverySettingsPage() {
  const actor = await requireActor();
  const t = await getTranslations('delivery');
  const { db } = services();
  const channels = await listDeliveryChannels(db, actor.orgId);
  const canManage = canManageConnections(actor.roles);
  // Which skills post to each channel: owners and admins only (they manage the channels).
  const usage = canManage ? await listChannelUsage(db, actor) : {};
  return (
    <SettingsPage title={t('title')} description={t('intro')}>
      {channels.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Send />
            </EmptyMedia>
            <EmptyTitle>{t('empty')}</EmptyTitle>
            <EmptyDescription>{t('emptyHint')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ConnectionList>
          {channels.map((c) => {
            const users = usage[c.id] ?? [];
            return (
              <ConnectionCard
                key={c.id}
                data-channel={c.kind}
                icon={c.kind === 'smtp' ? <Mail /> : <MessageSquare />}
                title={c.name}
                badges={<Badge variant="secondary">{t(`kinds.${c.kind}`)}</Badge>}
                details={
                  <>
                    <span>{c.hint}</span>
                    {canManage && c.kind !== 'smtp' && (
                      <span data-channel-usage>
                        {users.length > 0
                          ? t('usedBy', { skills: users.map((u) => u.name).join(', ') })
                          : t('unused')}
                      </span>
                    )}
                  </>
                }
                error={
                  c.lastError
                    ? t('lastError', {
                        reason: isChannelErrorCode(c.lastError)
                          ? c.lastError === 'rejected'
                            ? t('errors.rejectedNoStatus')
                            : t(`errors.${c.lastError}`)
                          : t('errors.unknown'),
                      })
                    : undefined
                }
                danger={canManage && <DeleteChannelButton id={c.id} name={c.name} />}
              />
            );
          })}
        </ConnectionList>
      )}
      {canManage ? (
        <ChannelForm />
      ) : (
        <p className="text-sm text-muted-foreground">{t('readOnlyNotice')}</p>
      )}
    </SettingsPage>
  );
}
