import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

export const LOCALES = ['en', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];

const pick = (value: string | null | undefined): Locale | null => {
  const l = value?.slice(0, 2).toLowerCase();
  return (LOCALES as readonly string[]).includes(l ?? '') ? (l as Locale) : null;
};

export default getRequestConfig(async () => {
  const locale =
    pick((await cookies()).get('locale')?.value) ??
    pick((await headers()).get('accept-language')) ??
    'en';
  return { locale, messages: (await import(`../../messages/${locale}.json`)).default };
});
