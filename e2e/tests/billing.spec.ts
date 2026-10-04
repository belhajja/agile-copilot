import { expect, test } from '@playwright/test';
import { signUpWithWorkspace } from '../helpers';

// e2e runs self-host (no Stripe settings): billing must be invisible and inert.
test('self-host: no Billing page or link, and the Stripe webhook answers 404', async ({
  page,
  request,
}) => {
  await signUpWithWorkspace(page);
  await expect(page.getByRole('link', { name: 'Members' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Billing' })).toHaveCount(0);
  const res = await page.goto('/settings/billing');
  expect(res?.status()).toBe(404);

  // Public in the proxy (no session: Stripe authenticates by signature), off without billing.
  const hook = await request.post('/api/billing/webhook', {
    data: '{}',
    headers: { 'stripe-signature': 't=1,v1=forged' },
  });
  expect(hook.status()).toBe(404);
  expect(await hook.json()).toEqual({ error: 'not_found' });
});
