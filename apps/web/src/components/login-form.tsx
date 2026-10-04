'use client';

import { ChevronDown, KeyRound } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type ComponentProps, type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { authClient } from '@/lib/auth-client';
import { useAuthErrorMessage } from '@/lib/auth-error';
import { loginPath } from '@/lib/next-path';
import { cn } from '@/lib/utils';

interface LoginFormProps extends ComponentProps<'div'> {
  sso: { providerId: string; name: string; ready: boolean } | null;
  passwordLogin: 'all' | 'admin_only';
  /** Safe in-app path to open after signing in (checked by the page). */
  next: string;
  /** Allowlisted `?error=` code from the SSO callback (`unknown` for anything else). */
  initialError: string | null;
}

export function LoginForm({
  className,
  sso,
  passwordLogin,
  next,
  initialError,
  ...props
}: LoginFormProps) {
  const t = useTranslations('auth');
  const errorMessage = useAuthErrorMessage();
  const router = useRouter();
  const [error, setError] = useState<string | null>(
    initialError ? errorMessage({ code: initialError }) : null,
  );
  const [pending, setPending] = useState<'password' | 'sso' | null>(null);
  const adminOnly = passwordLogin === 'admin_only';

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending('password');
    setError(null);
    const form = new FormData(e.currentTarget);
    const { error } = await authClient.signIn.email({
      email: String(form.get('email')),
      password: String(form.get('password')),
    });
    setPending(null);
    if (error) return setError(errorMessage(error));
    router.push(next);
    router.refresh();
  }

  /**
   * A fetch that answers with the identity provider's URL, then a top-level navigation there (not
   * a form post, so the `form-action 'self'` CSP does not apply). While the provider is being
   * discovered the request can take a few seconds (M1): the button shows it is working.
   */
  async function onSso() {
    if (!sso) return;
    setPending('sso');
    setError(null);
    try {
      const { error } = await authClient.signIn.social({
        provider: sso.providerId,
        callbackURL: next,
        // Failures come back to this page as ?error=<code>, still knowing where to go (L28).
        errorCallbackURL: loginPath(next),
      });
      if (error) {
        setPending(null);
        setError(errorMessage(error));
      }
    } catch {
      setPending(null);
      setError(errorMessage(null));
    }
  }

  const passwordForm = (
    <form onSubmit={onSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="email">{t('email')}</FieldLabel>
          <Input
            id="email"
            name="email"
            type="email"
            placeholder="m@example.com"
            autoComplete="email"
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="password">{t('password')}</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
        <Field>
          <Button type="submit" variant={sso ? 'outline' : 'default'} disabled={pending !== null}>
            {pending === 'password' && <Spinner aria-hidden />}
            {t('signIn')}
          </Button>
          {!adminOnly && (
            <FieldDescription className="text-center">
              {t('noAccount')}{' '}
              <Link href={next === '/' ? '/signup' : `/signup?next=${encodeURIComponent(next)}`}>
                {t('signUpLink')}
              </Link>
            </FieldDescription>
          )}
        </Field>
      </FieldGroup>
    </form>
  );

  return (
    <div className={cn('flex flex-col gap-6', className)} {...props}>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">{t('loginTitle')}</CardTitle>
          <CardDescription>{t('loginDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            {sso && (
              <Field>
                <Button
                  type="button"
                  onClick={onSso}
                  disabled={pending !== null || !sso.ready}
                  aria-busy={pending === 'sso'}
                >
                  {pending === 'sso' ? <Spinner aria-hidden /> : <KeyRound />}
                  {t('ssoButton', { name: sso.name })}
                </Button>
                {!sso.ready && (
                  <FieldDescription className="text-center">{t('ssoUnavailable')}</FieldDescription>
                )}
              </Field>
            )}
            {error && <FieldError>{error}</FieldError>}
            {sso && !adminOnly && <FieldSeparator>{t('orPassword')}</FieldSeparator>}
            {adminOnly ? (
              // Break-glass: platform administrators keep a password for when the IdP is down.
              <Collapsible>
                <CollapsibleTrigger asChild>
                  <Button type="button" variant="link" className="w-full">
                    {t('adminSignIn')}
                    <ChevronDown />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="grid gap-4 pt-4">
                  <FieldDescription className="text-center">
                    {t('adminSignInHint')}
                  </FieldDescription>
                  {passwordForm}
                </CollapsibleContent>
              </Collapsible>
            ) : (
              passwordForm
            )}
          </FieldGroup>
        </CardContent>
      </Card>
    </div>
  );
}
