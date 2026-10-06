'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { allowedCode, BLOCKED_REASONS } from '@/lib/error-code';
import { changeLlmModelAction, listModelsForConnectionAction } from './actions';
import { LLM_ERROR_CODES } from './error-codes';
import {
  type ModelsLoadFailure,
  OTHER_MODEL,
  type PickingState,
  pickingStateFromLoad,
} from './model-picker';

type State = { mode: 'idle' } | { mode: 'loading' } | ({ mode: 'picking' } & PickingState);

/** "Change model": loads what the stored key can use, then saves the pick. */
export function ChangeModelButton({ id, model }: { id: string; model: string }) {
  const t = useTranslations('llm');
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<State>({ mode: 'idle' });

  const errorText = (err: ModelsLoadFailure) => {
    const blockedReason =
      err.code === 'blocked_url' ? allowedCode(err.reason, BLOCKED_REASONS) : null;
    return blockedReason
      ? t(`errors.blocked.${blockedReason}`, { host: err.host ?? '' })
      : t(`errors.${allowedCode(err.code, LLM_ERROR_CODES) ?? 'unknown'}`);
  };

  const load = () => {
    setState({ mode: 'loading' });
    startTransition(async () => {
      const result = await listModelsForConnectionAction(id);
      // A failure (unauthorized, provider_error, Azure's not_supported, …) still falls back to
      // free text alongside the error, instead of leaving the user at a dead end.
      setState({ mode: 'picking', ...pickingStateFromLoad(result, model) });
    });
  };

  const save = (newModel: string) => {
    startTransition(async () => {
      const result = await changeLlmModelAction(id, newModel);
      if (result.ok) {
        toast.success(t('modelChanged'));
        setState({ mode: 'idle' });
      } else {
        toast.error(errorText({ code: result.code }));
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

  return (
    <div className="flex flex-wrap items-center gap-2">
      {state.error && <span className="text-sm text-destructive">{errorText(state.error)}</span>}
      {!state.error && state.models.length === 0 && (
        <span className="text-sm text-muted-foreground">{t('noModelsFound')}</span>
      )}
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
