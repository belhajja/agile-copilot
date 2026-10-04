'use client';

import { useTranslations } from 'next-intl';

/**
 * Maps a better-auth client error to a translated message: `auth.errors.<code>` when we have one,
 * `auth.genericError` otherwise. better-auth's own `message` is English-only, so it is never shown.
 */
export function useAuthErrorMessage() {
  const t = useTranslations('auth');
  return (error: { code?: string } | null | undefined): string => {
    const key = `errors.${error?.code}`;
    return error?.code && t.has(key) ? t(key) : t('genericError');
  };
}
