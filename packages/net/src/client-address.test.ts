import { describe, expect, it } from 'vitest';
import { clientAddress } from './client-address';

const xff = (value: string) => new Headers({ 'x-forwarded-for': value });

describe('clientAddress', () => {
  it('never reads X-Forwarded-For without a trusted proxy (hops 0): the client wrote it', () => {
    expect(clientAddress(xff('203.0.113.7'), 0)).toBeNull();
    expect(clientAddress(xff('1.1.1.1, 203.0.113.7'), 0)).toBeNull();
    expect(clientAddress(new Headers(), 0)).toBeNull();
  });

  it('takes the entry the trusted proxies wrote: hops places from the end', () => {
    expect(clientAddress(xff('203.0.113.7'), 1)).toBe('203.0.113.7');
    // A client-written entry on the left is ignored.
    expect(clientAddress(xff('1.1.1.1, 203.0.113.7'), 1)).toBe('203.0.113.7');
    expect(clientAddress(xff('1.1.1.1 , 203.0.113.7, 10.0.0.2'), 2)).toBe('203.0.113.7');
    expect(clientAddress(xff('2001:db8::1'), 1)).toBe('2001:db8::1');
  });

  it('is null when the chain is shorter than the hops or the entry is not an address', () => {
    expect(clientAddress(new Headers(), 1)).toBeNull();
    expect(clientAddress(xff('203.0.113.7'), 2)).toBeNull();
    expect(clientAddress(xff('not-an-ip'), 1)).toBeNull();
    expect(clientAddress(xff('1.1.1.1, '), 1)).toBe('1.1.1.1');
    expect(clientAddress(xff('203.0.113.7'), Number.NaN)).toBeNull();
  });
});
