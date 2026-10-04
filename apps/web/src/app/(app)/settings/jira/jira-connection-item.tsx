import type { JiraConnectionView } from '@agile/connections';
import { Cloud, LayoutGrid, Server } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ConfirmDeleteButton } from '@/components/confirm-delete-button';
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
import { allowedCode } from '@/lib/error-code';
import { deleteJiraConnectionAction, retestJiraConnectionAction } from './actions';
import { JIRA_ERROR_CODES } from './error-codes';

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
            {t(`errors.${allowedCode(c.lastError, JIRA_ERROR_CODES) ?? 'unknown'}`)}
          </p>
        )}
      </ItemContent>
      <ItemActions className="flex-wrap">
        <Button asChild variant="outline" size="sm">
          <Link href={`/settings/jira/${c.id}`}>
            <LayoutGrid />
            {t('boards')}
          </Link>
        </Button>
        {canManage && (
          <form action={retestJiraConnectionAction.bind(null, c.id)}>
            <Button variant="outline" size="sm">
              {t('retest')}
            </Button>
          </form>
        )}
        {canManage && (
          <ConfirmDeleteButton
            onConfirm={deleteJiraConnectionAction.bind(null, c.id)}
            labels={{
              trigger: t('delete'),
              title: t('deleteTitle'),
              description: t('deleteDescription', { name: c.name }),
              confirm: t('delete'),
              cancel: t('cancel'),
            }}
          />
        )}
      </ItemActions>
    </Item>
  );
}
