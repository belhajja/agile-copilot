import { canManageConnections } from '@agile/auth';
import { listChannelUsage, listDeliveryChannels } from '@agile/notify';
import { Mail, MessageSquare, Send } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
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
    <div className="mx-auto grid w-full max-w-4xl gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground">{t('intro')}</p>
      </div>
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
        <ItemGroup className="gap-3">
          {channels.map((c) => {
            const users = usage[c.id] ?? [];
            return (
              <Item key={c.id} variant="outline" data-channel={c.kind}>
                <ItemMedia variant="icon">
                  {c.kind === 'smtp' ? <Mail /> : <MessageSquare />}
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {c.name}
                    <Badge variant="secondary">{t(`kinds.${c.kind}`)}</Badge>
                  </ItemTitle>
                  <ItemDescription className="wrap-anywhere">{c.hint}</ItemDescription>
                  {canManage && c.kind !== 'smtp' && (
                    <p className="text-sm text-muted-foreground" data-channel-usage>
                      {users.length > 0
                        ? t('usedBy', { skills: users.map((u) => u.name).join(', ') })
                        : t('unused')}
                    </p>
                  )}
                  {c.lastError && (
                    <p className="text-sm text-destructive">
                      {t('lastError', {
                        reason: isChannelErrorCode(c.lastError)
                          ? c.lastError === 'rejected'
                            ? t('errors.rejectedNoStatus')
                            : t(`errors.${c.lastError}`)
                          : t('errors.unknown'),
                      })}
                    </p>
                  )}
                </ItemContent>
                {canManage && (
                  <ItemActions>
                    <DeleteChannelButton id={c.id} name={c.name} />
                  </ItemActions>
                )}
              </Item>
            );
          })}
        </ItemGroup>
      )}
      {canManage ? (
        <ChannelForm />
      ) : (
        <p className="text-sm text-muted-foreground">{t('readOnlyNotice')}</p>
      )}
    </div>
  );
}
