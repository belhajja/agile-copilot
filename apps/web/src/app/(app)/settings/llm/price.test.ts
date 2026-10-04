import { describe, expect, it } from 'vitest';
import { MAX_PRICE_MICROS, parsePrice } from './price';

describe('parsePrice', () => {
  it.each([
    ['3', 3_000_000],
    ['0.15', 150_000],
    ['0', 0],
    [' 15.00 ', 15_000_000],
    ['1.123456', 1_123_456],
    ['1000', MAX_PRICE_MICROS],
    ['', null],
    ['   ', null],
  ])('%j -> %j', (input, micros) => {
    expect(parsePrice(input)).toEqual({ ok: true, micros });
  });

  it('accepts the comma as decimal separator (French input)', () => {
    expect(parsePrice('0,15')).toEqual({ ok: true, micros: 150_000 });
    expect(parsePrice('3,5')).toEqual({ ok: true, micros: 3_500_000 });
  });

  it.each([
    'abc',
    '1.1234567', // more than 6 decimals
    '-1',
    '-0.5',
    '1000.000001', // above the cap
    '5000',
    '1.2.3',
    '1,2,3',
    '1e3',
    '.5',
    '3 4',
  ])('rejects %j', (input) => {
    expect(parsePrice(input)).toEqual({ ok: false });
  });
});
