import { can, seatsInUse } from '@agile/auth';
import { billingView, PLANS } from '@agile/billing';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { SettingsPage } from '@/components/settings/settings-page';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { allowedCode } from '@/lib/error-code';
import { billingDeps } from '@/server/billing';
import { requireActor, services } from '@/server/context';
import { BillingButtons } from './billing-buttons';
import { BILLING_STATUSES } from './billing-codes';

/** SaaS only: the workspace's plan and limits; owners upgrade or manage it in Stripe. */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string | string[] }>;
}) {
  const actor = await requireActor();
  const deps = billingDeps();
  if (!deps.billing) notFound();
  const { checkout } = await searchParams;
  const t = await getTranslations('billing');
  const format = await getFormatter();
  const [view, seats] = await Promise.all([
    billingView(deps, actor.orgId),
    // Members plus pending invitations: what the seat limit counts (L10).
    seatsInUse(services().db, actor.orgId),
  ]);
  const e = view.entitlements;
  const paid = e.plan === 'team';
  const status = allowedCode(view.status, BILLING_STATUSES);
  const limit = (n: number | null) => (n === null ? t('unlimited') : format.number(n));
  return (
    <SettingsPage title={t('title')} description={t('intro')}>
      {checkout === 'done' && <p className="text-sm">{t('checkoutDone')}</p>}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {t(`plans.${paid ? 'team' : 'free'}`)}
            {status && <Badge variant="secondary">{t(`status.${status}`)}</Badge>}
          </CardTitle>
          <CardDescription>
            {view.currentPeriodEnd &&
              t(view.cancelAtPeriodEnd ? 'endsOn' : 'renewsOn', {
                date: format.dateTime(view.currentPeriodEnd, { dateStyle: 'long' }),
              })}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <dl className="grid gap-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">{t('seats')}</dt>
              <dd className="tabular-nums">
                {format.number(seats)} / {limit(e.maxSeats)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('boards')}</dt>
              <dd className="tabular-nums">{limit(e.maxBoards)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('externalMcp')}</dt>
              <dd>{e.externalMcp ? t('included') : t('notIncluded')}</dd>
            </div>
          </dl>
          {!paid && (
            <p className="text-sm text-muted-foreground">
              {t('teamPitch', {
                seats: PLANS.team.maxSeats ?? 0,
                boards: PLANS.team.maxBoards ?? 0,
              })}
            </p>
          )}
          <p className="text-sm text-muted-foreground">{t('securityIncluded')}</p>
          {can(actor.roles, 'billing.manage') ? (
            <BillingButtons paid={paid} hasCustomer={view.hasCustomer} />
          ) : (
            <p className="text-sm text-muted-foreground">{t('ownerOnly')}</p>
          )}
        </CardContent>
      </Card>
    </SettingsPage>
  );
}
