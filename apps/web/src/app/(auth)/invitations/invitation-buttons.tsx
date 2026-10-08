'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldError } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { useAuthErrorMessage } from '@/lib/auth-error';
import { acceptInvitationAction, type InvitationState, rejectInvitationAction } from './actions';

const idle: InvitationState = { status: 'idle' };

export function InvitationButtons({ invitationId }: { invitationId: string }) {
  const t = useTranslations('invitations');
  const errorMessage = useAuthErrorMessage();
  const [accepted, accept, accepting] = useActionState(
    acceptInvitationAction.bind(null, invitationId),
    idle,
  );
  const [rejected, reject, rejecting] = useActionState(
    rejectInvitationAction.bind(null, invitationId),
    idle,
  );
  const failed = [accepted, rejected].find((s) => s.status === 'error');
  return (
    <Field>
      <div className="flex gap-2">
        <form action={accept} className="flex-1">
          <Button
            type="submit"
            className="w-full"
            disabled={accepting || rejecting}
            aria-busy={accepting}
          >
            {accepting && <Spinner aria-hidden />}
            {t('accept')}
          </Button>
        </form>
        <form action={reject}>
          <Button
            type="submit"
            variant="outline"
            disabled={accepting || rejecting}
            aria-busy={rejecting}
          >
            {rejecting && <Spinner aria-hidden />}
            {t('decline')}
          </Button>
        </form>
      </div>
      {failed?.status === 'error' && <FieldError>{errorMessage({ code: failed.code })}</FieldError>}
    </Field>
  );
}
