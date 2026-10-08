import { redirect } from 'next/navigation';
import { SignupForm } from '@/components/signup-form';
import { loginPath, safeNextPath } from '@/lib/next-path';
import { services } from '@/server/context';

export const dynamic = 'force-dynamic';

/**
 * Self-service sign-up exists only while everyone may use a password (break-glass accounts are
 * created server-side by an operator, never here).
 */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  if (services().env.PASSWORD_LOGIN === 'admin_only') redirect(loginPath(next));
  return <SignupForm next={safeNextPath(next)} inviteOnly={services().env.SIGNUP === 'invite'} />;
}
