'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { type DeleteAccountState, deleteAccountAction } from './actions';

const idle: DeleteAccountState = { status: 'idle' };

export function DeleteAccountForm({ email }: { email: string }) {
  const t = useTranslations('account');
  const [state, action, pending] = useActionState(deleteAccountAction, idle);
  return (
    <form action={action} className="grid gap-4">
      <Field>
        <FieldLabel htmlFor="confirm-email">{t('deleteConfirmLabel', { email })}</FieldLabel>
        <Input id="confirm-email" name="confirm" autoComplete="off" required />
        <FieldDescription>{t('deleteHint')}</FieldDescription>
      </Field>
      {state.status === 'error' && (
        <FieldError>
          {state.code === 'sole_owner'
            ? t('deleteSoleOwner', { workspaces: state.workspaces?.join(', ') ?? '' })
            : state.code === 'reauth'
              ? t('deleteReauth')
              : state.code === 'rate_limited'
                ? t('deleteRateLimited')
                : t('deleteMismatch')}
        </FieldError>
      )}
      <div>
        <Button type="submit" variant="destructive" disabled={pending} aria-busy={pending}>
          {pending && <Spinner aria-hidden />}
          {t('deleteButton')}
        </Button>
      </div>
    </form>
  );
}
