'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useId } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { type FormState, setLlmPricesAction } from './actions';

const fromMicros = (v: number | null) => (v === null ? '' : String(v / 1_000_000));

/** Prices per million tokens for the cost meter (optional; tokens are counted either way). */
export function LlmPriceForm({
  id,
  inputMicros,
  outputMicros,
}: {
  id: string;
  inputMicros: number | null;
  outputMicros: number | null;
}) {
  const t = useTranslations('llm');
  const [state, action, pending] = useActionState<FormState, FormData>(
    setLlmPricesAction.bind(null, id),
    { status: 'idle' },
  );
  const inputId = useId();
  const outputId = useId();
  const message =
    state.status === 'ok'
      ? t('pricesSaved')
      : state.status === 'error'
        ? state.code === 'invalid_price'
          ? t('pricesInvalid')
          : state.code === 'forbidden_role' || state.code === 'not_found'
            ? t(`errors.${state.code}`)
            : t('errors.unknown')
        : t('pricesHint');
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" data-prices={id}>
      <Field className="w-36">
        <FieldLabel htmlFor={inputId}>{t('inputPrice')}</FieldLabel>
        <Input
          id={inputId}
          name="input"
          inputMode="decimal"
          defaultValue={fromMicros(inputMicros)}
          placeholder="3.00"
        />
      </Field>
      <Field className="w-36">
        <FieldLabel htmlFor={outputId}>{t('outputPrice')}</FieldLabel>
        <Input
          id={outputId}
          name="output"
          inputMode="decimal"
          defaultValue={fromMicros(outputMicros)}
          placeholder="15.00"
        />
      </Field>
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {t('savePrices')}
      </Button>
      <p role="status" className="basis-full text-sm text-muted-foreground">
        {message}
      </p>
    </form>
  );
}
