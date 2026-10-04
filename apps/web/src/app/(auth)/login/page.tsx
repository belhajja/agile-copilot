import { LoginForm } from '@/components/login-form';
import { pickCode } from '@/lib/error-code';
import { safeNextPath } from '@/lib/next-path';
import { SSO_ERROR_CODES } from '@/lib/sso-error-codes';
import { signInOptions } from '@/server/sign-in-options';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const options = await signInOptions();
  return (
    <LoginForm
      sso={options.sso}
      passwordLogin={options.passwordLogin}
      next={safeNextPath(next)}
      // The SSO callback's error code, shown translated; anything else reads as a generic error.
      initialError={error === undefined ? null : pickCode(error, SSO_ERROR_CODES)}
    />
  );
}
