import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SECRET_PREFIX = 's1.';

export class CryptoError extends Error {
  override name = 'CryptoError';
}

export interface Keyring {
  currentVersion: number;
  keys: ReadonlyMap<number, Buffer>;
}

export interface WrappedDek {
  kekVersion: number;
  wrapped: string;
}

export function parseKeyring(spec: string): Keyring {
  const keys = new Map<number, Buffer>();
  let currentVersion = 0;
  for (const part of spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const match = /^v(\d+):(.+)$/.exec(part);
    if (!match) throw new CryptoError('ENCRYPTION_KEYS entries must look like v1:<base64>');
    const version = Number(match[1]);
    const key = Buffer.from(match[2] ?? '', 'base64');
    if (key.length !== 32) {
      throw new CryptoError(`Encryption key v${version} must be 32 bytes (got ${key.length})`);
    }
    if (keys.has(version)) throw new CryptoError(`Duplicate encryption key version v${version}`);
    keys.set(version, key);
    currentVersion = Math.max(currentVersion, version);
  }
  if (keys.size === 0) throw new CryptoError('ENCRYPTION_KEYS is empty');
  return { currentVersion, keys };
}

function seal(key: Buffer, aad: string, plaintext: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}

function open(key: Buffer, aad: string, sealed: string): Buffer {
  const parts = sealed.split('.');
  if (parts.length !== 3) throw new CryptoError('Malformed ciphertext');
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64url')) as [Buffer, Buffer, Buffer];
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES)
    throw new CryptoError('Malformed ciphertext');
  try {
    const decipher = createDecipheriv(ALG, key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new CryptoError('Decryption failed (wrong key, wrong context, or tampered data)');
  }
}

export function generateDek(): Buffer {
  return randomBytes(32);
}

export function wrapDek(keyring: Keyring, orgId: string, dek: Buffer): WrappedDek {
  const kek = keyring.keys.get(keyring.currentVersion);
  if (!kek) throw new CryptoError(`Missing current key v${keyring.currentVersion}`);
  return { kekVersion: keyring.currentVersion, wrapped: seal(kek, `dek:${orgId}`, dek) };
}

export function unwrapDek(keyring: Keyring, orgId: string, w: WrappedDek): Buffer {
  const kek = keyring.keys.get(w.kekVersion);
  if (!kek) throw new CryptoError(`Unknown encryption key version v${w.kekVersion}`);
  return open(kek, `dek:${orgId}`, w.wrapped);
}

export function encryptSecret(dek: Buffer, context: string, plaintext: string): string {
  return SECRET_PREFIX + seal(dek, context, Buffer.from(plaintext, 'utf8'));
}

export function decryptSecret(dek: Buffer, context: string, payload: string): string {
  if (!payload.startsWith(SECRET_PREFIX)) throw new CryptoError('Unsupported secret format');
  return open(dek, context, payload.slice(SECRET_PREFIX.length)).toString('utf8');
}
