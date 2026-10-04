'use client';

import { KeyRound } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldError } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { authClient } from '@/lib/auth-client';
import { useAuthErrorMessage } from '@/lib/auth-error';

/**
 * Links the identity provider to this (password) account: the user proves both, the password by
 * being signed in and the IdP by signing in there with the same, verified address. Like the login
 * button, a fetch then a top-level navigation; it may wait while the IdP is discovered (M1).
 */
export function LinkSsoButton({ providerId, name }: { providerId: string; name: string }) {
  const t = useTranslations('account');
  const errorMessage = useAuthErrorMessage();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Field>
      <div>
        <Button
          variant="outline"
          disabled={pending}
          aria-busy={pending}
          onClick={async () => {
            setPending(true);
            setError(null);
            try {
              const { error } = await authClient.linkSocial({
                provider: providerId,
                callbackURL: '/settings/account?linked=1',
                // better-auth appends ?error=<code>.
                errorCallbackURL: '/settings/account',
              });
              if (error) {
                setPending(false);
                setError(errorMessage(error));
              }
            } catch {
              setPending(false);
              setError(errorMessage(null));
            }
          }}
        >
          {pending ? <Spinner aria-hidden /> : <KeyRound />}
          {t('linkSso', { name })}
        </Button>
      </div>
      {error && <FieldError>{error}</FieldError>}
    </Field>
  );
}
