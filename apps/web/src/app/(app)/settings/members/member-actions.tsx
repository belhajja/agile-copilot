'use client';

import type { Role } from '@agile/auth/client';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ConfirmDeleteButton } from '@/components/confirm-delete-button';
import { FieldError } from '@/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { authClient } from '@/lib/auth-client';
import { useAuthErrorMessage } from '@/lib/auth-error';

/** Change one member's role, or remove them (owners and admins; never themselves). */
export function MemberActions({
  memberId,
  name,
  role,
  assignable,
}: {
  memberId: string;
  name: string;
  role: Role | null;
  assignable: Role[];
}) {
  const t = useTranslations('members');
  const tr = useTranslations('invitations.roles');
  const errorMessage = useAuthErrorMessage();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <div className="flex items-center justify-end gap-2">
      <NativeSelect
        aria-label={t('roleOf', { name })}
        value={role ?? ''}
        disabled={pending}
        onChange={async (e) => {
          setPending(true);
          setError(null);
          const { error } = await authClient.organization.updateMemberRole({
            memberId,
            role: e.target.value as Role,
          });
          setPending(false);
          if (error) return setError(errorMessage(error));
          router.refresh();
        }}
      >
        {role === null && <NativeSelectOption value="">{t('noRole')}</NativeSelectOption>}
        {assignable.map((r) => (
          <NativeSelectOption key={r} value={r}>
            {tr(r)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <ConfirmDeleteButton
        labels={{
          trigger: t('remove'),
          title: t('removeTitle', { name }),
          description: t('removeDescription'),
          confirm: t('remove'),
          cancel: t('cancel'),
        }}
        onConfirm={async () => {
          const { error } = await authClient.organization.removeMember({
            memberIdOrEmail: memberId,
          });
          if (error) return setError(errorMessage(error));
          router.refresh();
        }}
      />
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}
