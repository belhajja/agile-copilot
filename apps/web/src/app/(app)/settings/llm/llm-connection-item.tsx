import type { LlmConnectionView } from '@agile/connections';
import { Bot } from 'lucide-react';
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
import {
  deleteLlmConnectionAction,
  retestLlmConnectionAction,
  setDefaultLlmConnectionAction,
} from './actions';
import { BackgroundModelButton } from './background-model-button';
import { LLM_ERROR_CODES } from './error-codes';
import { LlmPriceForm } from './llm-price-form';

export async function LlmConnectionItem({
  c,
  canManage,
}: {
  c: LlmConnectionView;
  canManage: boolean;
}) {
  const t = await getTranslations('llm');
  const status = { ok: t('connected'), error: t('failing'), untested: t('untested') }[c.status];
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        <Bot />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {c.label}
          <Badge
            variant={
              c.status === 'ok' ? 'default' : c.status === 'error' ? 'destructive' : 'secondary'
            }
          >
            {status}
          </Badge>
          {c.isDefault && <Badge variant="outline">{t('default')}</Badge>}
          {c.isBackground && <Badge variant="outline">{t('background')}</Badge>}
        </ItemTitle>
        <ItemDescription>
          {t(`providers.${c.provider}`)} · {c.model}
          {c.keyHint ? ` · ${c.keyHint}` : ''}
        </ItemDescription>
        {c.lastError && (
          <p className="text-sm text-destructive">
            {t(`errors.${allowedCode(c.lastError, LLM_ERROR_CODES) ?? 'unknown'}`)}
          </p>
        )}
        {canManage && (
          <LlmPriceForm
            id={c.id}
            inputMicros={c.inputPriceMicros}
            outputMicros={c.outputPriceMicros}
          />
        )}
      </ItemContent>
      {canManage && (
        <ItemActions className="flex-wrap">
          {!c.isDefault && (
            <form action={setDefaultLlmConnectionAction.bind(null, c.id)}>
              <Button variant="outline" size="sm">
                {t('makeDefault')}
              </Button>
            </form>
          )}
          <BackgroundModelButton id={c.id} isBackground={c.isBackground} />
          <form action={retestLlmConnectionAction.bind(null, c.id)}>
            <Button variant="outline" size="sm">
              {t('retest')}
            </Button>
          </form>
          <ConfirmDeleteButton
            onConfirm={deleteLlmConnectionAction.bind(null, c.id)}
            labels={{
              trigger: t('delete'),
              title: t('deleteTitle'),
              description: t('deleteDescription', { label: c.label }),
              confirm: t('delete'),
              cancel: t('cancel'),
            }}
          />
        </ItemActions>
      )}
    </Item>
  );
}
