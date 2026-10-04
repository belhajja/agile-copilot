'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { type BillingState, checkoutAction, portalAction } from './actions';

const idle: BillingState = { status: 'idle' };

export function BillingButtons({ paid, hasCustomer }: { paid: boolean; hasCustomer: boolean }) {
  const t = useTranslations('billing');
  const [checkout, startCheckout, checkingOut] = useActionState(checkoutAction, idle);
  const [portal, openPortal, opening] = useActionState(portalAction, idle);
  const failed = [checkout, portal].find((s) => s.status === 'error');
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        {!paid && (
          <form action={startCheckout}>
            <Button type="submit" disabled={checkingOut}>
              {t('upgrade')}
            </Button>
          </form>
        )}
        {hasCustomer && (
          <form action={openPortal}>
            <Button type="submit" variant="outline" disabled={opening}>
              {t('manage')}
            </Button>
          </form>
        )}
      </div>
      {/* The code is one of BILLING_ERROR_CODES (the action allowlists it). */}
      {failed?.status === 'error' && <FieldError>{t(`errors.${failed.code}`)}</FieldError>}
    </div>
  );
}
