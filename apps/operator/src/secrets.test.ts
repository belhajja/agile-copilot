import { describe, expect, it } from 'vitest';
import { generateSecrets } from './secrets';

describe('generateSecrets', () => {
  it('makes URL-safe database passwords and 32-byte keys', () => {
    const s = generateSecrets();
    expect(s.postgresPassword).toMatch(/^[0-9a-f]{48}$/);
    expect(s.appDbPassword).toMatch(/^[0-9a-f]{48}$/);
    expect(Buffer.from(s.betterAuthSecret, 'base64')).toHaveLength(32);
    expect(s.encryptionKeys).toMatch(/^v1:[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(s.encryptionKeys.slice(3), 'base64')).toHaveLength(32);
  });

  it('never repeats a value', () => {
    const a = generateSecrets();
    const b = generateSecrets();
    expect(new Set([...Object.values(a), ...Object.values(b)]).size).toBe(8);
  });
});
