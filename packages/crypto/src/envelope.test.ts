import { describe, expect, it } from 'vitest';
import {
  CryptoError,
  decryptSecret,
  encryptSecret,
  generateDek,
  parseKeyring,
  unwrapDek,
  wrapDek,
} from './envelope';

const k = (byte: number) => Buffer.alloc(32, byte).toString('base64');

describe('parseKeyring', () => {
  it('uses the highest version as current', () => {
    const ring = parseKeyring(`v1:${k(1)}, v2:${k(2)}`);
    expect(ring.currentVersion).toBe(2);
    expect(ring.keys.size).toBe(2);
  });

  it.each([
    ['', /empty/],
    ['nope', /v1:<base64>/],
    [`v1:${Buffer.alloc(16).toString('base64')}`, /32 bytes/],
    [`v1:${k(1)},v1:${k(2)}`, /duplicate/i],
  ])('rejects %j', (spec, error) => {
    expect(() => parseKeyring(spec)).toThrow(error);
  });
});

describe('DEK wrapping', () => {
  it('round-trips and survives key rotation', () => {
    const v1 = parseKeyring(`v1:${k(1)}`);
    const dek = generateDek();
    const wrapped = wrapDek(v1, 'org_a', dek);
    expect(wrapped.kekVersion).toBe(1);

    const rotated = parseKeyring(`v1:${k(1)},v2:${k(2)}`);
    expect(unwrapDek(rotated, 'org_a', wrapped).equals(dek)).toBe(true);
    expect(wrapDek(rotated, 'org_a', dek).kekVersion).toBe(2);
  });

  it('cannot be unwrapped for another org', () => {
    const ring = parseKeyring(`v1:${k(1)}`);
    const wrapped = wrapDek(ring, 'org_a', generateDek());
    expect(() => unwrapDek(ring, 'org_b', wrapped)).toThrow(CryptoError);
  });

  it('reports a missing key version', () => {
    const wrapped = wrapDek(parseKeyring(`v3:${k(3)}`), 'org_a', generateDek());
    expect(() => unwrapDek(parseKeyring(`v1:${k(1)}`), 'org_a', wrapped)).toThrow(/v3/);
  });
});

describe('secrets', () => {
  const dek = generateDek();

  it('round-trips unicode and never contains the plaintext', () => {
    const payload = encryptSecret(dek, 'jira_connection:1', 'tökén-🔑');
    expect(payload.startsWith('s1.')).toBe(true);
    expect(payload).not.toContain('tökén');
    expect(decryptSecret(dek, 'jira_connection:1', payload)).toBe('tökén-🔑');
  });

  it('uses a fresh IV each time', () => {
    expect(encryptSecret(dek, 'c', 'x')).not.toBe(encryptSecret(dek, 'c', 'x'));
  });

  it('is bound to its context (ciphertexts cannot be swapped between rows)', () => {
    const payload = encryptSecret(dek, 'jira_connection:1', 'secret');
    expect(() => decryptSecret(dek, 'jira_connection:2', payload)).toThrow(CryptoError);
  });

  it('detects tampering and malformed input without leaking details', () => {
    const payload = encryptSecret(dek, 'c', 'secret');
    const parts = payload.split('.');
    const ct = Buffer.from(parts[3] ?? '', 'base64url');
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    parts[3] = ct.toString('base64url');
    expect(() => decryptSecret(dek, 'c', parts.join('.'))).toThrow(CryptoError);
    expect(() => decryptSecret(dek, 'c', 'garbage')).toThrow(CryptoError);
  });
});
