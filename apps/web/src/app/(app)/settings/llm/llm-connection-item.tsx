import type { LlmConnectionView } from '@agile/connections';
import { Bot } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { ConfirmDeleteButton } from '@/components/confirm-delete-button';
import { ConnectionCard, ConnectionCardSection } from '@/components/settings/connection-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { allowedCode } from '@/lib/error-code';
import {
  deleteLlmConnectionAction,
  retestLlmConnectionAction,
  setDefaultLlmConnectionAction,
} from './actions';
import { BackgroundModelButton } from './background-model-button';
import { ChangeModelButton } from './change-model-button';
import { LLM_ERROR_CODES } from './error-codes';
import { LlmAcceptsImagesForm } from './llm-accepts-images-form';
import { LlmAnswerBudgetForm } from './llm-answer-budget-form';
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
    <ConnectionCard
      icon={<Bot />}
      title={c.label}
      badges={
        <>
          <Badge
            variant={
              c.status === 'ok' ? 'default' : c.status === 'error' ? 'destructive' : 'secondary'
            }
          >
            {status}
          </Badge>
          {c.isDefault && <Badge variant="outline">{t('default')}</Badge>}
          {c.isBackground && <Badge variant="outline">{t('background')}</Badge>}
        </>
      }
      details={
        <>
          {t(`providers.${c.provider}`)} · {c.model}
          {c.keyHint ? ` · ${c.keyHint}` : ''}
        </>
      }
      error={
        c.lastError
          ? t(`errors.${allowedCode(c.lastError, LLM_ERROR_CODES) ?? 'unknown'}`)
          : undefined
      }
      actions={
        canManage && (
          <>
            <ChangeModelButton id={c.id} model={c.model} />
            <form action={retestLlmConnectionAction.bind(null, c.id)}>
              <Button variant="outline" size="sm">
                {t('retest')}
              </Button>
            </form>
            {!c.isDefault && (
              <form action={setDefaultLlmConnectionAction.bind(null, c.id)}>
                <Button variant="outline" size="sm">
                  {t('makeDefault')}
                </Button>
              </form>
            )}
            <BackgroundModelButton id={c.id} isBackground={c.isBackground} />
          </>
        )
      }
      danger={
        canManage && (
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
        )
      }
    >
      {canManage && (
        <>
          <ConnectionCardSection title={t('answerBudget')} description={t('answerBudgetHint')}>
            <LlmAnswerBudgetForm id={c.id} maxOutputTokens={c.maxOutputTokens} />
          </ConnectionCardSection>
          <ConnectionCardSection title={t('imagesTitle')} description={t('acceptsImagesHint')}>
            <LlmAcceptsImagesForm id={c.id} acceptsImages={c.acceptsImages} />
          </ConnectionCardSection>
          <ConnectionCardSection title={t('pricesTitle')} description={t('pricesHint')}>
            <LlmPriceForm
              id={c.id}
              inputMicros={c.inputPriceMicros}
              outputMicros={c.outputPriceMicros}
            />
          </ConnectionCardSection>
        </>
      )}
    </ConnectionCard>
  );
}
