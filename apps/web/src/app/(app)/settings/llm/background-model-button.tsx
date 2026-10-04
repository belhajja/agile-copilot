'use client';

import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { setBackgroundLlmConnectionAction } from './actions';

/** Picks (or clears) the model used for background skill runs; a refusal is shown, not dropped. */
export function BackgroundModelButton({ id, isBackground }: { id: string; isBackground: boolean }) {
  const t = useTranslations('llm');
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await setBackgroundLlmConnectionAction(isBackground ? null : id);
          if (result.ok) toast.success(t('backgroundSaved'));
          else
            toast.error(
              t.has(`errors.${result.code}`) ? t(`errors.${result.code}`) : t('errors.unknown'),
            );
        })
      }
    >
      {isBackground ? t('useDefaultForBackground') : t('useForBackground')}
    </Button>
  );
}
