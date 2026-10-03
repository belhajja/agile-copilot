import type { JiraConnectionView } from '@agile/connections';
import { Cloud, Server } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { deleteJiraConnectionAction, retestJiraConnectionAction } from './actions';

export async function JiraConnectionItem({
  c,
  canManage,
}: {
  c: JiraConnectionView;
  canManage: boolean;
}) {
  const t = await getTranslations('jira');
  const status = { ok: t('connected'), error: t('failing'), untested: t('untested') }[c.status];
  const Icon = c.deployment === 'cloud' ? Cloud : Server;
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {c.name}
          <Badge
            variant={
              c.status === 'ok' ? 'default' : c.status === 'error' ? 'destructive' : 'secondary'
            }
          >
            {status}
          </Badge>
        </ItemTitle>
        <ItemDescription>
          {c.baseUrl}
          {c.accountName ? ` · ${c.accountName}` : ''}
        </ItemDescription>
        {c.lastError && (
          <p className="text-sm text-destructive">
            {t.has(`errors.${c.lastError}`) ? t(`errors.${c.lastError}`) : t('errors.unknown')}
          </p>
        )}
      </ItemContent>
      {canManage && (
        <ItemActions>
          <form action={retestJiraConnectionAction.bind(null, c.id)}>
            <Button variant="outline" size="sm">
              {t('retest')}
            </Button>
          </form>
          <form action={deleteJiraConnectionAction.bind(null, c.id)}>
            <Button variant="ghost" size="sm">
              {t('delete')}
            </Button>
          </form>
        </ItemActions>
      )}
    </Item>
  );
}
