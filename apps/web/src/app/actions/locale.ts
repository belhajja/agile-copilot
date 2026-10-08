'use server';

import { cookies } from 'next/headers';
import { z } from 'zod';
import { LOCALES } from '@/i18n/request';

export async function setLocale(locale: unknown) {
  const parsed = z.enum(LOCALES).safeParse(locale);
  if (!parsed.success) return;
  (await cookies()).set('locale', parsed.data, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
}
