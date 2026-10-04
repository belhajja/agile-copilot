import { describe, expect, it } from 'vitest';
import { EnvError } from './env';
import { parseWorkerEnv } from './worker-env';

const valid = {
  DATABASE_URL: 'postgres://app_user:pw@localhost:5432/agile',
  BETTER_AUTH_SECRET: 's'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3000',
  ENCRYPTION_KEYS: `v1:${Buffer.alloc(32, 1).toString('base64')}`,
};

describe('parseWorkerEnv', () => {
  it('adds worker defaults to the server environment', () => {
    expect(parseWorkerEnv(valid)).toMatchObject({
      DATABASE_URL: valid.DATABASE_URL,
      SYNC_INTERVAL_MINUTES: 15,
      WORKER_HEALTH_PORT: 8080,
      WORKER_HEALTH_HOST: '127.0.0.1',
    });
  });

  it('treats empty values as unset and reads numbers', () => {
    expect(
      parseWorkerEnv({
        ...valid,
        SYNC_INTERVAL_MINUTES: '',
        WORKER_HEALTH_PORT: '4030',
        WORKER_HEALTH_HOST: '',
      }),
    ).toMatchObject({
      SYNC_INTERVAL_MINUTES: 15,
      WORKER_HEALTH_PORT: 4030,
      WORKER_HEALTH_HOST: '127.0.0.1',
    });
  });

  it('rejects intervals the scheduler cannot express', () => {
    expect(() => parseWorkerEnv({ ...valid, SYNC_INTERVAL_MINUTES: '7' })).toThrow(EnvError);
    expect(() => parseWorkerEnv({ ...valid, SYNC_INTERVAL_MINUTES: '7' })).toThrow(
      /SYNC_INTERVAL_MINUTES/,
    );
    expect(() => parseWorkerEnv({ ...valid, SYNC_INTERVAL_MINUTES: '20' })).toThrow(EnvError);
  });

  it('still validates the shared server settings', () => {
    expect(() => parseWorkerEnv({ ...valid, ENCRYPTION_KEYS: undefined })).toThrow(
      /ENCRYPTION_KEYS/,
    );
  });

  it('names keys but never echoes values', () => {
    const secret = 'super-secret-value-that-is-short';
    let message = '';
    try {
      parseWorkerEnv({ ...valid, BETTER_AUTH_SECRET: 'short', DATABASE_URL: `nope-${secret}` });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/BETTER_AUTH_SECRET/);
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).not.toContain(secret);
    expect(message).not.toContain('short');
  });
});
