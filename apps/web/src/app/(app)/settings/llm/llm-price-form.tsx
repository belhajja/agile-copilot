'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useActionState, useId } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { type FormState, setLlmPricesAction } from './actions';

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
  const format = useFormatter();
  // Locale decimal separator (French "3,00"); the server parser accepts both "." and ",".
  const decimal = (v: number) =>
    format.number(v, { minimumFractionDigits: 2, maximumFractionDigits: 6, useGrouping: false });
  const fromMicros = (v: number | null) => (v === null ? '' : decimal(v / 1_000_000));
  const [state, action, pending] = useActionState<FormState, FormData>(
    setLlmPricesAction.bind(null, id),
    { status: 'idle' },
  );
  const inputId = useId();
  const outputId = useId();
  // The section above already says what the prices are for: only outcomes are shown here.
  const message =
    state.status === 'ok'
      ? t('pricesSaved')
      : state.status === 'error'
        ? state.code === 'invalid_price'
          ? t('pricesInvalid')
          : state.code === 'forbidden_role' || state.code === 'not_found'
            ? t(`errors.${state.code}`)
            : t('errors.unknown')
        : null;
  return (
    <form action={action} className="grid gap-2" data-prices={id}>
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-full sm:w-44">
          <FieldLabel htmlFor={inputId}>{t('inputPrice')}</FieldLabel>
          <Input
            id={inputId}
            name="input"
            inputMode="decimal"
            defaultValue={fromMicros(inputMicros)}
            placeholder={decimal(3)}
          />
        </Field>
        <Field className="w-full sm:w-44">
          <FieldLabel htmlFor={outputId}>{t('outputPrice')}</FieldLabel>
          <Input
            id={outputId}
            name="output"
            inputMode="decimal"
            defaultValue={fromMicros(outputMicros)}
            placeholder={decimal(15)}
          />
        </Field>
        <Button type="submit" variant="outline" disabled={pending}>
          {t('savePrices')}
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
