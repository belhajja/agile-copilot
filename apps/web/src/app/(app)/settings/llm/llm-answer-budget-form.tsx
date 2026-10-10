'use client';

import { DEFAULT_MAX_OUTPUT_TOKENS } from '@agile/llm/output-budget';
import { useFormatter, useTranslations } from 'next-intl';
import { useActionState, useId } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { type FormState, setLlmAnswerBudgetAction } from './actions';

/** How many tokens the model may write per call (empty: the default). */
export function LlmAnswerBudgetForm({
  id,
  maxOutputTokens,
}: {
  id: string;
  maxOutputTokens: number | null;
}) {
  const t = useTranslations('llm');
  const format = useFormatter();
  const [state, action, pending] = useActionState<FormState, FormData>(
    setLlmAnswerBudgetAction.bind(null, id),
    { status: 'idle' },
  );
  const inputId = useId();
  const message =
    state.status === 'ok'
      ? t('answerBudgetSaved')
      : state.status === 'error'
        ? state.code === 'invalid_answer_budget' ||
          state.code === 'forbidden_role' ||
          state.code === 'not_found'
          ? t(`errors.${state.code}`)
          : t('errors.unknown')
        : null;
  return (
    <form action={action} className="grid gap-2" data-answer-budget={id}>
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-full sm:w-44">
          <FieldLabel htmlFor={inputId} className="sr-only">
            {t('answerBudget')}
          </FieldLabel>
          <Input
            id={inputId}
            name="maxOutputTokens"
            inputMode="numeric"
            defaultValue={maxOutputTokens ?? ''}
            placeholder={format.number(DEFAULT_MAX_OUTPUT_TOKENS)}
          />
        </Field>
        <Button type="submit" variant="outline" disabled={pending} aria-busy={pending}>
          {pending && <Spinner aria-hidden />}
          {t('saveAnswerBudget')}
        </Button>
      </div>
      <p
        role="status"
        className={state.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}
      >
        {message}
      </p>
    </form>
  );
}
