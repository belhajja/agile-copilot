import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { KEYCLOAK_IMAGE } from './testing/keycloak';

const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');

describe('development Keycloak (docker-compose.yml)', () => {
  const services = (
    parse(read('docker-compose.yml')) as {
      services: Record<string, { image?: string; ports?: string[]; profiles?: string[] }>;
    }
  ).services;

  it('runs the contract-tested image, opt-in, on loopback only', () => {
    expect(services.keycloak?.image).toBe(KEYCLOAK_IMAGE);
    expect(services.keycloak?.profiles).toEqual(['sso']);
    expect(services.keycloak?.ports).toEqual(['127.0.0.1:4100:8080']);
  });

  it('is not part of the self-host stack (each deployment brings its own identity provider)', () => {
    const selfhost = read('docker-compose.selfhost.yml');
    expect(Object.keys((parse(selfhost) as { services: object }).services)).not.toContain(
      'keycloak',
    );
    expect(selfhost).not.toContain('quay.io/keycloak');
  });
});
