import 'server-only';
import { type BillingDeps, getEntitlements } from '@agile/billing';
import { billingConfigOf } from '@agile/config';
import { services } from './context';

/** Billing dependencies; `billing` is null (off) in self-host deployments. */
export function billingDeps(): BillingDeps {
  const { db, env } = services();
  return { db, billing: billingConfigOf(env) };
}

export const billingEnabled = () => billingDeps().billing !== null;

/** The workspace's plan limits (unlimited when billing is off). */
export const entitlements = (orgId: string) => getEntitlements(billingDeps(), orgId);
