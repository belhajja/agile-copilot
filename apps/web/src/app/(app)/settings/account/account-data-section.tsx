import { getTranslations } from 'next-intl/server';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DeleteAccountForm } from './delete-account-form';

/** Codes with a sentence under `account.exportErrors` (the throttle refusals of the export). */
export const EXPORT_ERROR_CODES = ['export_in_progress', 'export_rate_limited'] as const;
export type ExportErrorCode = (typeof EXPORT_ERROR_CODES)[number];

/**
 * The Account page's personal-data cards: download my data, delete my account. Needs a session
 * only (M3), never a workspace; the Account page (Task 7) renders it below the sign-in methods.
 */
export async function AccountDataSection({
  email,
  exportError,
}: {
  email: string;
  /** Why the last export was refused (an allowlisted code), from the export route's redirect. */
  exportError?: ExportErrorCode | null;
}) {
  const t = await getTranslations('account');
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t('dataTitle')}</CardTitle>
          <CardDescription>{t('dataHint')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {exportError && (
            <Alert variant="destructive">
              <AlertDescription>{t(`exportErrors.${exportError}`)}</AlertDescription>
            </Alert>
          )}
          {/* A download (attachment) from a plain POST form: never a GET link, so pages elsewhere
              cannot start exports (A-m5). */}
          <form action="/api/account/export" method="post">
            <Button type="submit" variant="outline">
              {t('export')}
            </Button>
          </form>
        </CardContent>
      </Card>
      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle>{t('deleteTitle')}</CardTitle>
          <CardDescription>{t('deleteDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <DeleteAccountForm email={email} />
        </CardContent>
      </Card>
    </>
  );
}
