import { describe, expect, it } from 'vitest';
import { canLinkSso } from './sign-in-methods';

const base = {
  ssoConfigured: true,
  ssoProvider: 'keycloak',
  linkedProviders: new Set(['credential']),
  email: 'pat@example.com',
  breakGlassEmails: ['root@example.com'],
};

describe('canLinkSso', () => {
  it('offers linking to a password user while SSO is configured', () => {
    expect(canLinkSso(base)).toBe(true);
  });

  it('not without SSO, not twice, never to a break-glass account (any letter case)', () => {
    expect(canLinkSso({ ...base, ssoConfigured: false })).toBe(false);
    expect(canLinkSso({ ...base, linkedProviders: new Set(['credential', 'keycloak']) })).toBe(
      false,
    );
    expect(canLinkSso({ ...base, email: ' Root@Example.com ' })).toBe(false);
  });
});
