import { describe, expect, it } from 'vitest';
import { authErrorCode } from './auth-error';

describe('authErrorCode', () => {
  it('keeps a known code and drops an unknown one', () => {
    expect(authErrorCode({ code: 'INVALID_EMAIL_OR_PASSWORD' })).toBe('INVALID_EMAIL_OR_PASSWORD');
    expect(authErrorCode({ code: 'constructor' })).toBeNull();
    expect(authErrorCode(null)).toBeNull();
  });

  it('reads a 429 without a code as too many requests (both sign-in limits answer so)', () => {
    expect(authErrorCode({ status: 429 })).toBe('TOO_MANY_REQUESTS');
    expect(authErrorCode({ status: 500 })).toBeNull();
  });
});
