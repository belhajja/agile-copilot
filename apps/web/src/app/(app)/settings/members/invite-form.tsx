'use client';

import type { Role } from '@agile/auth/client';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { authClient } from '@/lib/auth-client';
import { useAuthErrorMessage } from '@/lib/auth-error';

export function InviteForm({ assignable }: { assignable: Role[] }) {
  const t = useTranslations('members');
  const tr = useTranslations('invitations.roles');
  const errorMessage = useAuthErrorMessage();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    setPending(true);
    setError(null);
    const { error } = await authClient.organization.inviteMember({
      email: String(form.get('email')).trim(),
      role: String(form.get('role')) as Role,
    });
    setPending(false);
    if (error) return setError(errorMessage(error));
    formEl.reset();
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('inviteTitle')}</CardTitle>
        <CardDescription>{t('inviteHint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit}>
          <FieldGroup className="@xl/main:flex-row @xl/main:items-end">
            <Field>
              <FieldLabel htmlFor="invite-email">{t('email')}</FieldLabel>
              <Input id="invite-email" name="email" type="email" required maxLength={254} />
            </Field>
            <Field className="@xl/main:max-w-48">
              <FieldLabel htmlFor="invite-role">{t('role')}</FieldLabel>
              <NativeSelect id="invite-role" name="role" defaultValue="viewer">
                {assignable.map((r) => (
                  <NativeSelectOption key={r} value={r}>
                    {tr(r)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field className="@xl/main:w-auto">
              <Button type="submit" disabled={pending} aria-busy={pending}>
                {pending && <Spinner aria-hidden />}
                {t('invite')}
              </Button>
            </Field>
          </FieldGroup>
          {error && <FieldError className="mt-2">{error}</FieldError>}
        </form>
      </CardContent>
    </Card>
  );
}
