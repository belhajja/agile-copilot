'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { allowedCode } from '@/lib/error-code';
import { changeLlmModelAction, listModelsForConnectionAction } from './actions';
import { LLM_ERROR_CODES } from './error-codes';

const OTHER_MODEL = '__other__';

type State =
  | { mode: 'idle' }
  | { mode: 'loading' }
  | { mode: 'error'; code: string }
  | { mode: 'picking'; models: string[]; selected: string; other: boolean };

/** "Change model": loads what the stored key can use, then saves the pick. */
export function ChangeModelButton({ id, model }: { id: string; model: string }) {
  const t = useTranslations('llm');
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<State>({ mode: 'idle' });

  const errorText = (code: string) =>
    t(`errors.${allowedCode(code, LLM_ERROR_CODES) ?? 'unknown'}`);

  const load = () => {
    setState({ mode: 'loading' });
    startTransition(async () => {
      const result = await listModelsForConnectionAction(id);
      if (!result.ok) {
        // Azure deployments cannot be listed: go straight to free text instead of a dead end.
        if (result.code === 'not_supported') {
          setState({ mode: 'picking', models: [], selected: model, other: true });
          return;
        }
        setState({ mode: 'error', code: result.code });
        return;
      }
      setState({
        mode: 'picking',
        models: result.models,
        selected: result.models.includes(model) ? model : (result.models[0] ?? ''),
        other: result.models.length === 0,
      });
    });
  };

  const save = (newModel: string) => {
    startTransition(async () => {
      const result = await changeLlmModelAction(id, newModel);
      if (result.ok) {
        toast.success(t('modelChanged'));
        setState({ mode: 'idle' });
      } else {
        toast.error(errorText(result.code));
      }
    });
  };

  if (state.mode === 'idle' || state.mode === 'loading') {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={pending || state.mode === 'loading'}
        onClick={load}
      >
        {t('changeModel')}
      </Button>
    );
  }

  if (state.mode === 'error') {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-destructive">{errorText(state.code)}</span>
        <Button variant="outline" size="sm" onClick={load}>
          {t('changeModel')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {state.other ? (
        <Input
          className="h-8 w-48"
          defaultValue={state.selected}
          onChange={(e) => setState({ ...state, selected: e.target.value })}
        />
      ) : (
        <NativeSelect
          value={state.selected}
          onChange={(e) => {
            if (e.target.value === OTHER_MODEL) setState({ ...state, other: true, selected: '' });
            else setState({ ...state, selected: e.target.value });
          }}
        >
          {state.models.length === 0 && (
            <NativeSelectOption value="">{t('noModelsFound')}</NativeSelectOption>
          )}
          {state.models.map((m) => (
            <NativeSelectOption key={m} value={m}>
              {m}
            </NativeSelectOption>
          ))}
          <NativeSelectOption value={OTHER_MODEL}>{t('other')}</NativeSelectOption>
        </NativeSelect>
      )}
      <Button
        size="sm"
        disabled={pending || !state.selected.trim()}
        onClick={() => save(state.selected)}
      >
        {t('save')}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setState({ mode: 'idle' })}>
        {t('cancel')}
      </Button>
    </div>
  );
}
