import { describe, expect, it } from 'vitest';
import { loginPath, safeNextPath } from './next-path';

describe('safeNextPath', () => {
  it('keeps paths inside the app', () => {
    expect(safeNextPath('/invitations/abc123')).toBe('/invitations/abc123');
    expect(safeNextPath('/boards/1?tab=flow')).toBe('/boards/1?tab=flow');
  });

  it('refuses anything that could leave the app', () => {
    for (const bad of [
      '//evil.example',
      '/\\evil.example',
      'https://evil.example',
      'javascript:alert(1)',
      '/a b',
      '/a//evil.example',
      '/.//evil.example',
      '/%5Cevil',
      '/%5cevil',
      '/%2F%2Fevil.example',
      '/%2f%2fevil.example',
      '/a%2F%2Fb',
      '/%E0%A4%A',
      '',
      undefined,
      ['/x'],
      `/${'a'.repeat(600)}`,
    ]) {
      expect(safeNextPath(bad)).toBe('/');
    }
  });
});

describe('loginPath', () => {
  it('carries the page to come back to', () => {
    expect(loginPath('/invitations/inv_1')).toBe('/login?next=%2Finvitations%2Finv_1');
  });

  it('is plain /login for the home page or an unsafe path', () => {
    expect(loginPath('/')).toBe('/login');
    expect(loginPath('//evil.example')).toBe('/login');
    expect(loginPath(undefined)).toBe('/login');
  });
});
