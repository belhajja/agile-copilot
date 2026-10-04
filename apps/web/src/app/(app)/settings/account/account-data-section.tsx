import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DeleteAccountForm } from './delete-account-form';

/**
 * The Account page's personal-data cards: download my data, delete my account. Needs a session
 * only (M3), never a workspace; the Account page (Task 7) renders it below the sign-in methods.
 */
export async function AccountDataSection({ email }: { email: string }) {
  const t = await getTranslations('account');
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t('dataTitle')}</CardTitle>
          <CardDescription>{t('dataHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            {/* A download (attachment), not a page: a plain link. */}
            <a href="/api/account/export" download>
              {t('export')}
            </a>
          </Button>
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
