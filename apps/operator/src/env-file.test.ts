import { describe, expect, it } from 'vitest';
import { envFor, parseEnv, redact, renderEnv, secretValues } from './env-file';
import { generateSecrets } from './secrets';
import { validateSettings } from './settings';

const images = { web: 'r/web:v1', worker: 'r/worker:v1', migrate: 'r/migrate:v1' };

describe('.env', () => {
  it('replaces known keys in place and keeps comments and unknown keys', () => {
    const before = '# mine\nWEB_IMAGE=old\nCUSTOM=kept\r\n';
    const after = renderEnv({ WEB_IMAGE: 'new', WORKER_IMAGE: 'w' }, before);
    expect(after).toBe('# mine\nWEB_IMAGE=new\nCUSTOM=kept\nWORKER_IMAGE=w\n');
    expect(parseEnv(after).get('CUSTOM')).toBe('kept');
  });

  it('writes what the self-host compose files read, per mode', () => {
    const local = envFor(validateSettings({ port: '3100' }), generateSecrets(), images);
    expect(local).toMatchObject({
      COMPOSE_PROJECT_NAME: 'agile-copilot',
      BETTER_AUTH_URL: 'http://localhost:3100',
      WEB_PORT: '3100',
      WEB_IMAGE: 'r/web:v1',
    });
    expect(local.APP_DOMAIN).toBeUndefined();
    const server = envFor(
      validateSettings({ mode: 'server', domain: 'c.example.com', 'acme-email': 'o@example.com' }),
      generateSecrets(),
      images,
    );
    expect(server).toMatchObject({ APP_DOMAIN: 'c.example.com', ACME_EMAIL: 'o@example.com' });
  });

  it('redacts the secret values only, longest first', () => {
    const env = parseEnv(
      'POSTGRES_PASSWORD=abcd1234\nWEB_PORT=3000\nENCRYPTION_KEYS=v1:abcd1234xyz\n',
    );
    const text = 'pw abcd1234 key v1:abcd1234xyz port 3000';
    expect(redact(text, secretValues(env))).toBe('pw ••• key ••• port 3000');
  });
});
