import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('./actions', () => ({
  checkoutAction: async () => ({ status: 'idle' }),
  portalAction: async () => ({ status: 'idle' }),
}));

const { BillingButtons } = await import('./billing-buttons');

describe('BillingButtons', () => {
  it('renders both buttons disabled until hydrated (no native form post to Stripe)', () => {
    // Before hydration a submit would post the form natively; the redirect to Stripe would then
    // need `form-action` to allow Stripe. Disabled server markup keeps the CSP at 'self'.
    const html = renderToString(createElement(BillingButtons, { paid: false, hasCustomer: true }));
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const b of buttons) expect(b).toMatch(/\sdisabled=""/);
  });
});
