import { describe, expect, it } from 'vitest';
import { pickCode } from './error-code';

const ALLOWED = ['not_found', 'forbidden'] as const;

describe('pickCode', () => {
  it('returns an allowed code as is', () => {
    expect(pickCode('forbidden', ALLOWED)).toBe('forbidden');
  });

  it.each([
    'constructor',
    '__proto__',
    'toString',
    'library.retro-prep.title',
    ['not_found', 'forbidden'],
    ['a', 'b'],
    undefined,
    42,
    '',
  ])('maps %j to unknown', (value) => {
    expect(pickCode(value, ALLOWED)).toBe('unknown');
  });
});
