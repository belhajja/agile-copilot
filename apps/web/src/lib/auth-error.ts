'use client';

import { useTranslations } from 'next-intl';
import { allowedCode } from './error-code';
import { INVITATION_PAGE_ERRORS, SSO_ERROR_CODES } from './sso-error-codes';

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
  // Sign-in policy (Task 5): admin-only passwords, server-side break-glass, redirect-only SSO.
  'PASSWORD_LOGIN_DISABLED',
  'SIGN_UP_NOT_ALLOWED',
  'ID_TOKEN_SIGN_IN_DISABLED',
  'SCOPES_NOT_ALLOWED',
  'INVALID_CALLBACK_URL',
  'INVALID_ORIGIN',
  // SSO start or link while the identity provider is not (yet) discovered.
  'PROVIDER_NOT_FOUND',
  'SOCIAL_ACCOUNT_ALREADY_LINKED',
  // Workspace roles and invitations.
  'ROLE_NOT_ALLOWED',
  'FORBIDDEN_ROLE',
  'INVITATION_NOT_FOUND',
  'EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION',
  'ORGANIZATION_MEMBERSHIP_LIMIT_REACHED',
  'USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION',
  'USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION',
  'YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE',
  'YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER',
  'YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER',
  'YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER',
  'invalid_input',
  ...INVITATION_PAGE_ERRORS,
  ...SSO_ERROR_CODES,
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
