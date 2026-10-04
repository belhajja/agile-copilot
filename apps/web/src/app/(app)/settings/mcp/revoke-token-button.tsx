'use client';

import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ConfirmDeleteButton } from '@/components/confirm-delete-button';
import { pickCode } from '@/lib/error-code';
import { revokeTokenAction } from './actions';
import { MCP_ERROR_CODES } from './error-codes';

/** Revokes a token after confirmation; a refusal is shown as a translated message. */
export function RevokeTokenButton({ id, name }: { id: string; name: string }) {
  const t = useTranslations('mcp');
  return (
    <ConfirmDeleteButton
      onConfirm={async () => {
        const result = await revokeTokenAction(id);
        if (result.ok) toast.success(t('revokedToast'));
        else toast.error(t(`errors.${pickCode(result.code, MCP_ERROR_CODES)}`));
      }}
      labels={{
        trigger: t('revoke'),
        title: t('revokeTitle', { name }),
        description: t('revokeDescription'),
        confirm: t('revoke'),
        cancel: t('cancel'),
      }}
    />
  );
}
