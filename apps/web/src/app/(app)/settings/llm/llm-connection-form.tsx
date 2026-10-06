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
import {
  createLlmConnectionAction,
  type FormState,
  listModelsForNewConnectionAction,
} from './actions';
import { LLM_ERROR_CODES } from './error-codes';
import { canShowModelList, initialSelection, OTHER_MODEL } from './model-picker';

type ModelsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; models: string[] }
  | { status: 'error'; code: string; reason?: string; host?: string };

export function LlmConnectionForm() {
  const t = useTranslations('llm');
  const [state, action, pending] = useActionState<FormState, FormData>(createLlmConnectionAction, {
    status: 'idle',
  });
  const [provider, setProvider] = useState<LlmProvider>('anthropic');
  const [apiKeyFilled, setApiKeyFilled] = useState(false);
  const [baseUrlFilled, setBaseUrlFilled] = useState(false);
  const [modelsState, setModelsState] = useState<ModelsState>({ status: 'idle' });
  const [modelMode, setModelMode] = useState<'list' | 'other'>('other');
  const [modelValue, setModelValue] = useState('');
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.status === 'ok') {
      formRef.current?.reset();
      // reset() reverts the native select to its first option; keep the controlled state in agreement.
      setProvider('anthropic');
      setApiKeyFilled(false);
      setBaseUrlFilled(false);
      setModelsState({ status: 'idle' });
      setModelMode('other');
      setModelValue('');
      toast.success(t('saved'));
    }
  }, [state, t]);

  const resetModels = () => {
    setModelsState({ status: 'idle' });
    setModelMode('other');
  };

  const canLoadModels =
    provider !== 'azure' && (provider === 'openai_compatible' ? baseUrlFilled : apiKeyFilled);
  const showModelList =
    modelMode === 'list' && modelsState.status === 'loaded' && canShowModelList(modelsState.models);

  const loadModels = () => {
    if (!formRef.current) return;
    const data = new FormData(formRef.current);
    setModelsState({ status: 'loading' });
    startTransition(async () => {
      const result = await listModelsForNewConnectionAction(data);
      if (!result.ok) {
        setModelsState({
          status: 'error',
          code: result.code,
          reason: result.reason,
          host: result.host,
        });
        return;
      }
      setModelsState({ status: 'loaded', models: result.models });
      // An empty list stays in free-text mode: a <select> with only "Other…" would auto-select it.
      setModelMode(canShowModelList(result.models) ? 'list' : 'other');
      setModelValue(initialSelection(result.models, ''));
    });
  };

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

  const modelsBlockedReason =
    modelsState.status === 'error' && modelsState.code === 'blocked_url'
      ? allowedCode(modelsState.reason, BLOCKED_REASONS)
      : null;
  const modelsErrorText =
    modelsState.status !== 'error'
      ? null
      : modelsBlockedReason
        ? t(`errors.blocked.${modelsBlockedReason}`, { host: modelsState.host ?? '' })
        : t(`errors.${allowedCode(modelsState.code, LLM_ERROR_CODES) ?? 'unknown'}`);

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
                onChange={(e) => {
                  setProvider(e.target.value as LlmProvider);
                  resetModels();
                }}
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
            {provider === 'azure' && (
              <Field>
                <FieldLabel htmlFor="resourceName">{t('resourceName')}</FieldLabel>
                <Input id="resourceName" name="resourceName" required />
              </Field>
            )}
            {provider === 'openai_compatible' && (
              <Field>
                <FieldLabel htmlFor="baseUrl">{t('baseUrl')}</FieldLabel>
                <Input
                  id="baseUrl"
                  name="baseUrl"
                  required
                  placeholder="http://ollama:11434/v1"
                  onChange={(e) => {
                    setBaseUrlFilled(e.target.value.trim().length > 0);
                    resetModels();
                  }}
                />
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
                onChange={(e) => {
                  setApiKeyFilled(e.target.value.trim().length > 0);
                  resetModels();
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="model">{t('model')}</FieldLabel>
              {showModelList ? (
                <NativeSelect
                  id="model"
                  name="model"
                  value={modelValue}
                  onChange={(e) => {
                    if (e.target.value === OTHER_MODEL) {
                      setModelMode('other');
                      setModelValue('');
                    } else {
                      setModelValue(e.target.value);
                    }
                  }}
                >
                  {modelsState.status === 'loaded' &&
                    modelsState.models.map((m) => (
                      <NativeSelectOption key={m} value={m}>
                        {m}
                      </NativeSelectOption>
                    ))}
                  <NativeSelectOption value={OTHER_MODEL}>{t('other')}</NativeSelectOption>
                </NativeSelect>
              ) : (
                <Input
                  id="model"
                  name="model"
                  required
                  defaultValue={modelValue}
                  placeholder={provider === 'anthropic' ? 'claude-sonnet-5-5' : ''}
                />
              )}
              <div className="flex flex-wrap items-center gap-2">
                <FieldDescription>
                  {showModelList ? t('modelsHint') : t('modelHint')}
                </FieldDescription>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!canLoadModels || modelsState.status === 'loading'}
                  onClick={loadModels}
                >
                  {t('loadModels')}
                </Button>
              </div>
              {modelsState.status === 'loaded' && modelsState.models.length === 0 && (
                <FieldDescription>{t('noModelsFound')}</FieldDescription>
              )}
              {modelsErrorText && <FieldError>{modelsErrorText}</FieldError>}
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
