import { isBreakGlass } from '@agile/auth';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { allowedCode } from '@/lib/error-code';
import { SSO_ERROR_CODES } from '@/lib/sso-error-codes';
import { requireSignedIn, services } from '@/server/context';
import { AccountDataSection } from './account-data-section';
import { LinkSsoButton } from './link-sso-button';

export const dynamic = 'force-dynamic';

/**
 * The user's own account: how they sign in (and, below, their data). Open to anyone signed in,
 * with or without a workspace (M3), so it reads the session, never a workspace actor.
 */
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; linked?: string }>;
}) {
  const session = await requireSignedIn('/settings/account');
  const { error, linked } = await searchParams;
  const t = await getTranslations('account');
  const ta = await getTranslations('auth');
  const { env, auth } = services();
  const accounts = await auth.api.listUserAccounts({ headers: await headers() });
  const providers = new Set(accounts.map((a) => a.providerId));
  const ssoName = env.OIDC_DISPLAY_NAME;
  const hasSso = Boolean(env.OIDC_ISSUER) && providers.has(env.OIDC_PROVIDER);
  // Break-glass accounts stay password-only (they must work when the IdP is down or compromised).
  const canLink =
    Boolean(env.OIDC_ISSUER) &&
    !hasSso &&
    !isBreakGlass(session.user.email, env.BREAK_GLASS_EMAILS);
  // Why linking failed, from the SSO callback: only allowlisted codes are explained (L6).
  const reason = error === undefined ? null : allowedCode(error, SSO_ERROR_CODES);
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground">{session.user.email}</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t('signInMethods')}</CardTitle>
          <CardDescription>{t('signInMethodsHint')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex flex-wrap gap-2" data-sign-in-methods>
            {providers.has('credential') && <Badge variant="secondary">{t('password')}</Badge>}
            {hasSso && <Badge variant="secondary">{ssoName}</Badge>}
          </div>
          {linked === '1' && hasSso && (
            <Alert>
              <AlertDescription>{t('linked', { name: ssoName })}</AlertDescription>
            </Alert>
          )}
          {error !== undefined && (
            <Alert variant="destructive">
              <AlertDescription>
                {t('linkFailed', { name: ssoName })}
                {reason && ` ${ta(`errors.${reason}`)}`}
              </AlertDescription>
            </Alert>
          )}
          {canLink && <LinkSsoButton providerId={env.OIDC_PROVIDER} name={ssoName} />}
        </CardContent>
      </Card>
      {/* Download my data, delete my account (Task 12): a session is enough, no workspace (M3). */}
      <AccountDataSection email={session.user.email} />
    </div>
  );
}
