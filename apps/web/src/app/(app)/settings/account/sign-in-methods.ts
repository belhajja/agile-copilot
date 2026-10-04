import { isBreakGlass } from '@agile/auth';

/**
 * Whether the Account page offers "Link <IdP>": SSO configured, not linked yet, and never for a
 * break-glass account (it must keep working when the IdP is down or compromised).
 */
export function canLinkSso(input: {
  ssoConfigured: boolean;
  ssoProvider: string;
  linkedProviders: ReadonlySet<string>;
  email: string;
  breakGlassEmails: readonly string[];
}): boolean {
  return (
    input.ssoConfigured &&
    !input.linkedProviders.has(input.ssoProvider) &&
    !isBreakGlass(input.email, input.breakGlassEmails)
  );
}
