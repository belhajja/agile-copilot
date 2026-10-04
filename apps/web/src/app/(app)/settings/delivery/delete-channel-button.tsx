'use client';

import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ConfirmDeleteButton } from '@/components/confirm-delete-button';
import { deleteChannelAction } from './actions';

/** Removes a channel after confirmation; a refusal is shown as a translated message. */
export function DeleteChannelButton({ id, name }: { id: string; name: string }) {
  const t = useTranslations('delivery');
  return (
    <ConfirmDeleteButton
      onConfirm={async () => {
        const result = await deleteChannelAction(id);
        if (result.ok) toast.success(t('removed'));
        else
          toast.error(
            t.has(`errors.${result.code}`) ? t(`errors.${result.code}`) : t('errors.unknown'),
          );
      }}
      labels={{
        trigger: t('delete'),
        title: t('deleteTitle'),
        description: t('deleteDescription', { name }),
        confirm: t('delete'),
        cancel: t('cancel'),
      }}
    />
  );
}
