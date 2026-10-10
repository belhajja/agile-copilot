'use client';

import { useTranslations } from 'next-intl';
import { startTransition, useActionState, useEffect, useId, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { type FormState, setLlmAcceptsImagesAction } from './actions';

/** Whether the model reads images; saved as soon as the switch moves. */
export function LlmAcceptsImagesForm({
  id,
  acceptsImages,
}: {
  id: string;
  acceptsImages: boolean;
}) {
  const t = useTranslations('llm');
  const [checked, setChecked] = useState(acceptsImages);
  const [state, action, pending] = useActionState<FormState, FormData>(
    setLlmAcceptsImagesAction.bind(null, id),
    { status: 'idle' },
  );
  const switchId = useId();
  // Refused: back to what is stored.
  useEffect(() => {
    if (state.status === 'error') setChecked(acceptsImages);
  }, [state, acceptsImages]);
  const toggle = (next: boolean) => {
    setChecked(next);
    const form = new FormData();
    form.set('acceptsImages', String(next));
    startTransition(() => action(form));
  };
  const message =
    state.status === 'ok'
      ? t('acceptsImagesSaved')
      : state.status === 'error'
        ? state.code === 'forbidden_role' || state.code === 'not_found'
          ? t(`errors.${state.code}`)
          : t('errors.unknown')
        : null;
  return (
    <div className="grid gap-2" data-accepts-images={id}>
      <div className="flex items-center gap-3">
        <Switch
          id={switchId}
          checked={checked}
          onCheckedChange={toggle}
          disabled={pending}
          aria-busy={pending}
        />
        <Label htmlFor={switchId}>{t('acceptsImages')}</Label>
      </div>
      <p
        role="status"
        className={state.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}
      >
        {message}
      </p>
    </div>
  );
}
