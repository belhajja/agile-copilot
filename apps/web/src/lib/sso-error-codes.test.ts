import { describe, expect, it } from 'vitest';
import { invitationErrorOf, ssoErrorOf } from './sso-error-codes';

describe('ssoErrorOf (the ?error= of the login and account pages)', () => {
  it('keeps known codes, nothing when absent', () => {
    expect(ssoErrorOf('account_not_linked')).toBe('account_not_linked');
    expect(ssoErrorOf(undefined)).toBeNull();
  });

  it.each([
    'constructor',
    '__proto__',
    'toString',
    'errors.account_not_linked',
    'PASSWORD_LOGIN_DISABLED',
    ['account_not_linked'],
    '',
  ])('reads %j as a generic error', (value) => {
    expect(ssoErrorOf(value)).toBe('unknown');
  });
});

describe('invitationErrorOf (why an invitation link shows nothing)', () => {
  const apiError = (code: unknown) => ({ body: { code } });

  it('explains a verified address being required and a departed inviter', () => {
    expect(invitationErrorOf(apiError('EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION'))).toBe(
      'EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION',
    );
    expect(invitationErrorOf(apiError('INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION'))).toBe(
      'INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION',
    );
  });

  it('never confirms an invitation addressed to someone else, nor odd input', () => {
    for (const e of [
      apiError('YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION'),
      apiError('constructor'),
      apiError(['EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION']),
      new Error('boom'),
      null,
    ]) {
      expect(invitationErrorOf(e)).toBeNull();
    }
  });
});
