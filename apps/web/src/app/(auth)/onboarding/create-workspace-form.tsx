'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth-client';
import { useAuthErrorMessage } from '@/lib/auth-error';

const slugify = (name: string) =>
  `${
    name
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .slice(0, 40) || 'workspace'
  }-${crypto.randomUUID().slice(0, 6)}`;

export function CreateWorkspaceForm() {
  const t = useTranslations('onboarding');
  const errorMessage = useAuthErrorMessage();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    const name = String(new FormData(e.currentTarget).get('name')).trim();
    const created = await authClient.organization.create({ name, slug: slugify(name) });
    if (created.error || !created.data) {
      setPending(false);
      return setError(errorMessage(created.error));
    }
    const activated = await authClient.organization.setActive({ organizationId: created.data.id });
    if (activated.error) {
      setPending(false);
      return setError(errorMessage(activated.error));
    }
    router.push('/');
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="name">{t('workspaceName')}</FieldLabel>
          <Input id="name" name="name" required maxLength={80} />
        </Field>
        {error && <FieldError>{error}</FieldError>}
        <Field>
          <Button type="submit" disabled={pending}>
            {t('submit')}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
