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
    const selfhost = read('deploy/compose/docker-compose.yml');
    expect(Object.keys((parse(selfhost) as { services: object }).services)).not.toContain(
      'keycloak',
    );
    expect(selfhost).not.toContain('quay.io/keycloak');
  });
});

/** Keys of a zod object schema in a source file: `  KEY: z…` lines at the given indentation. */
const schemaKeys = (file: string, indent: number) =>
  [...read(file).matchAll(new RegExp(`^ {${indent}}([A-Z][A-Z0-9_]+):`, 'gm'))].map(
    (m) => m[1] ?? '',
  );

describe('self-host settings (deploy/compose/docker-compose.yml, .env.example)', () => {
  const services = (
    parse(read('deploy/compose/docker-compose.yml')) as {
      services: Record<string, { environment?: Record<string, string> }>;
    }
  ).services;
  const env = (name: string) => Object.keys(services[name]?.environment ?? {}).sort();
  const server = schemaKeys('packages/config/src/env.ts', 4);
  const workerExtras = schemaKeys('packages/config/src/worker-env.ts', 2);
  // Self-host builds never bill: no Stripe setting reaches them. NODE_ENV is set by the image.
  const web = server.filter((k) => k !== 'NODE_ENV' && !k.startsWith('STRIPE_'));

  it('reads the env schemas it checks against', () => {
    expect(server).toEqual(
      expect.arrayContaining(['DATABASE_URL', 'OIDC_ISSUER', 'TRUSTED_PROXY_HOPS']),
    );
    expect(workerExtras).toEqual([
      'SYNC_INTERVAL_MINUTES',
      'WORKER_HEALTH_PORT',
      'WORKER_HEALTH_HOST',
    ]);
  });

  it('passes every server setting except Stripe to the web app, and nothing else', () => {
    expect(env('web')).toEqual([...web].sort());
  });

  it('passes the worker only what it uses: no SSO, password policy, MCP or Stripe settings', () => {
    const webOnly = [
      'MCP_ATLASSIAN_URL',
      'OIDC_PROVIDER',
      'OIDC_ISSUER',
      'OIDC_CLIENT_ID',
      'OIDC_CLIENT_SECRET',
      'OIDC_DISPLAY_NAME',
      'PASSWORD_LOGIN',
      'BREAK_GLASS_EMAILS',
      'MCP_RATE_LIMIT_PER_MINUTE',
      'TRUSTED_PROXY_HOPS',
    ];
    expect(env('worker')).toEqual(
      [...web.filter((k) => !webOnly.includes(k)), ...workerExtras].sort(),
    );
  });

  it('keeps the schema defaults, so an empty .env behaves like the code', () => {
    const webEnv = services.web?.environment ?? {};
    /** `${KEY:-fallback}`: the value Compose takes from .env, with its default. */
    const fromEnv = (key: string, fallback: string) => `\${${key}:-${fallback}}`;
    expect(webEnv).toMatchObject({
      OIDC_PROVIDER: fromEnv('OIDC_PROVIDER', 'keycloak'),
      OIDC_DISPLAY_NAME: fromEnv('OIDC_DISPLAY_NAME', 'SSO'),
      PASSWORD_LOGIN: fromEnv('PASSWORD_LOGIN', 'all'),
      MCP_RATE_LIMIT_PER_MINUTE: fromEnv('MCP_RATE_LIMIT_PER_MINUTE', '60'),
      LANGFUSE_BASE_URL: fromEnv('LANGFUSE_BASE_URL', 'https://cloud.langfuse.com'),
      // The app is published directly by default: X-Forwarded-For is not trusted.
      TRUSTED_PROXY_HOPS: fromEnv('TRUSTED_PROXY_HOPS', '0'),
    });
  });

  it('documents every setting in .env.example', () => {
    const example = read('.env.example');
    for (const key of [...server.filter((k) => k !== 'NODE_ENV'), ...workerExtras]) {
      expect(example, key).toMatch(new RegExp(`^(# )?${key}=`, 'm'));
    }
  });
});

describe('self-host web service (deploy/compose/docker-compose.yml)', () => {
  const web = (
    parse(read('deploy/compose/docker-compose.yml')) as {
      services: Record<string, { healthcheck?: { test: string[] }; stop_grace_period?: string }>;
    }
  ).services.web;

  it('checks health on /healthz, never a page that starts identity-provider discovery', () => {
    const test = web?.healthcheck?.test.join(' ') ?? '';
    expect(test).toContain('http://127.0.0.1:3000/healthz');
    expect(test).not.toMatch(/\/(login|signup|api\/auth)/);
  });

  it('gives running requests and the trace flush 30 s to finish on stop', () => {
    expect(web?.stop_grace_period).toBe('30s');
  });
});

describe('the local deployment folder (deploy/compose)', () => {
  const compose = read('deploy/compose/docker-compose.yml');
  const example = read('deploy/compose/.env.example');
  // `${KEY` that Compose reads from .env (`$${...}` is a literal kept for the container's shell).
  const used = new Set([...compose.matchAll(/(?<!\$)\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));
  const documented = new Set([...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));

  it('documents every variable the compose file reads in .env.example, and nothing else', () => {
    expect([...used].sort()).toEqual([...documented].sort());
  });

  it('creates app_user with the same script as development', () => {
    const inline = (parse(compose) as { configs: Record<string, { content: string }> }).configs[
      'pg-init'
    ]?.content;
    const script = read('docker/postgres/init/01-app-role.sh').replace(/\r\n/g, '\n');
    expect(inline?.split('$$').join('$').trimEnd()).toBe(script.trimEnd());
  });

  it('publishes the app on this machine only, and builds nothing', () => {
    const services = (
      parse(compose) as {
        services: Record<string, { ports?: string[]; build?: unknown; image?: string }>;
      }
    ).services;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose interpolation, not a JS template
    expect(services.web?.ports).toEqual(['127.0.0.1:${WEB_PORT:-3000}:3000']);
    for (const [name, s] of Object.entries(services)) {
      expect(s.build, name).toBeUndefined();
      expect(s.image, name).toBeTruthy();
    }
  });
});
