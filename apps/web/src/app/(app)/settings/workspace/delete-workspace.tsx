'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth-client';
import { useAuthErrorMessage } from '@/lib/auth-error';

/** Owners only: deletes the workspace and all its data (billing is stopped first). */
export function DeleteWorkspace({ orgId, name }: { orgId: string; name: string }) {
  const t = useTranslations('workspace');
  const errorMessage = useAuthErrorMessage();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const typed = String(new FormData(e.currentTarget).get('confirm') ?? '').trim();
    if (typed !== name) return setError(t('deleteMismatch'));
    setPending(true);
    const { error } = await authClient.organization.delete({ organizationId: orgId });
    if (error) {
      setPending(false);
      return setError(errorMessage(error));
    }
    router.push('/');
    router.refresh();
  }

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle>{t('deleteTitle')}</CardTitle>
        <CardDescription>{t('deleteDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4">
          <Field>
            <FieldLabel htmlFor="confirm-workspace">{t('deleteConfirmLabel', { name })}</FieldLabel>
            <Input id="confirm-workspace" name="confirm" autoComplete="off" required />
          </Field>
          {error && <FieldError>{error}</FieldError>}
          <div>
            <Button type="submit" variant="destructive" disabled={pending}>
              {t('deleteButton')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
