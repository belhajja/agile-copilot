'use client';

import { useTranslations } from 'next-intl';
import { allowedCode } from './error-code';

/** better-auth error codes with a sentence under `auth.errors` (a test ties it to the messages). */
export const AUTH_ERROR_CODES = [
  'INVALID_EMAIL_OR_PASSWORD',
  'INVALID_EMAIL',
  'INVALID_PASSWORD',
  'PASSWORD_TOO_SHORT',
  'PASSWORD_TOO_LONG',
  'EMAIL_NOT_VERIFIED',
  'USER_ALREADY_EXISTS',
  'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
  'EMAIL_PASSWORD_SIGN_UP_DISABLED',
  'ORGANIZATION_ALREADY_EXISTS',
  'ORGANIZATION_SLUG_ALREADY_TAKEN',
  'YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION',
  'YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS',
  'ORGANIZATION_NOT_FOUND',
  'USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION',
] as const;

/**
 * Maps a better-auth client error to a translated message: `auth.errors.<code>` when we have one,
 * `auth.genericError` otherwise. better-auth's own `message` is English-only, so it is never shown.
 * The code comes from an HTTP answer: looked up in the list above, never with `t.has`.
 */
export function useAuthErrorMessage() {
  const t = useTranslations('auth');
  return (error: { code?: string } | null | undefined): string => {
    const code = allowedCode(error?.code, AUTH_ERROR_CODES);
    return code ? t(`errors.${code}`) : t('genericError');
  };
}
