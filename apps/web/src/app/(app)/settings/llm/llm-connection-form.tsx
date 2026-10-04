'use client';

import { LLM_PROVIDERS, type LlmProvider } from '@agile/llm/providers-list';
import { useTranslations } from 'next-intl';
import { startTransition, useActionState, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { allowedCode, BLOCKED_REASONS } from '@/lib/error-code';
import { createLlmConnectionAction, type FormState } from './actions';
import { LLM_ERROR_CODES } from './error-codes';

export function LlmConnectionForm() {
  const t = useTranslations('llm');
  const [state, action, pending] = useActionState<FormState, FormData>(createLlmConnectionAction, {
    status: 'idle',
  });
  const [provider, setProvider] = useState<LlmProvider>('anthropic');
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.status === 'ok') {
      formRef.current?.reset();
      // reset() reverts the native select to its first option; keep the controlled state in agreement.
      setProvider('anthropic');
      toast.success(t('saved'));
    }
  }, [state, t]);

  const blockedReason =
    state.status === 'error' && state.code === 'blocked_url'
      ? allowedCode(state.reason, BLOCKED_REASONS)
      : null;
  const errorText =
    state.status !== 'error'
      ? null
      : blockedReason
        ? t(`errors.blocked.${blockedReason}`, { host: state.host ?? '' })
        : t(`errors.${allowedCode(state.code, LLM_ERROR_CODES) ?? 'unknown'}`);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('add')}</CardTitle>
        <CardDescription>{t('intro')}</CardDescription>
      </CardHeader>
      <CardContent>
        {/* onSubmit + startTransition instead of <form action>: React resets the form after an action, which would
            wipe the typed fields (and the controlled provider select) after a failed attempt. */}
        <form
          ref={formRef}
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            startTransition(() => action(data));
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="provider">{t('provider')}</FieldLabel>
              <NativeSelect
                id="provider"
                name="provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value as LlmProvider)}
              >
                {LLM_PROVIDERS.map((p) => (
                  <NativeSelectOption key={p} value={p}>
                    {t(`providers.${p}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="label">{t('label')}</FieldLabel>
              <Input id="label" name="label" required maxLength={80} />
            </Field>
            <Field>
              <FieldLabel htmlFor="model">{t('model')}</FieldLabel>
              <Input
                id="model"
                name="model"
                required
                placeholder={provider === 'anthropic' ? 'claude-sonnet-5-5' : ''}
              />
              <FieldDescription>{t('modelHint')}</FieldDescription>
            </Field>
            {provider === 'azure' && (
              <Field>
                <FieldLabel htmlFor="resourceName">{t('resourceName')}</FieldLabel>
                <Input id="resourceName" name="resourceName" required />
              </Field>
            )}
            {provider === 'openai_compatible' && (
              <Field>
                <FieldLabel htmlFor="baseUrl">{t('baseUrl')}</FieldLabel>
                <Input id="baseUrl" name="baseUrl" required placeholder="http://ollama:11434/v1" />
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="apiKey">
                {provider === 'openai_compatible' ? t('apiKeyOptional') : t('apiKey')}
              </FieldLabel>
              <Input
                id="apiKey"
                name="apiKey"
                type="password"
                autoComplete="off"
                required={provider !== 'openai_compatible'}
              />
            </Field>
            {errorText && <FieldError>{errorText}</FieldError>}
            <Field>
              <Button type="submit" disabled={pending}>
                {t('submit')}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
