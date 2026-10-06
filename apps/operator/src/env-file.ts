import type { Secrets } from './secrets';
import { publicUrl, type Settings } from './settings';

const LINE = /^([A-Z][A-Z0-9_]*)=(.*)$/;

export function parseEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line.trim());
    if (m?.[1] !== undefined) values.set(m[1], m[2] ?? '');
  }
  return values;
}

/** `previous` with `values` set: known keys replaced in place, new keys appended, the rest kept. */
export function renderEnv(values: Record<string, string>, previous = ''): string {
  const pending = new Map(Object.entries(values));
  const lines = previous ? previous.replace(/\r\n/g, '\n').split('\n') : [];
  if (lines.at(-1) === '') lines.pop();
  const out = lines.map((line) => {
    const key = LINE.exec(line)?.[1];
    if (key === undefined || !pending.has(key)) return line;
    const value = pending.get(key);
    pending.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of pending) out.push(`${key}=${value}`);
  return `${out.join('\n')}\n`;
}

export const ENV_SECRET_KEYS = [
  'POSTGRES_PASSWORD',
  'APP_DB_PASSWORD',
  'BETTER_AUTH_SECRET',
  'ENCRYPTION_KEYS',
  'OIDC_CLIENT_SECRET',
  'OPERATOR_REGISTRY_TOKEN',
] as const;

export function secretValues(env: Map<string, string>): string[] {
  return ENV_SECRET_KEYS.map((k) => env.get(k) ?? '').filter((v) => v.length >= 4);
}

export function redact(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    result = result.split(s).join('•••');
  }
  return result;
}

export function envFor(
  s: Settings,
  secrets: Secrets,
  images: { web: string; worker: string; migrate: string },
): Record<string, string> {
  const env: Record<string, string> = {
    COMPOSE_PROJECT_NAME: 'agile-copilot',
    DEPLOYMENT_MODE: 'selfhost',
    POSTGRES_PASSWORD: secrets.postgresPassword,
    APP_DB_PASSWORD: secrets.appDbPassword,
    BETTER_AUTH_SECRET: secrets.betterAuthSecret,
    ENCRYPTION_KEYS: secrets.encryptionKeys,
    BETTER_AUTH_URL: publicUrl(s),
    WEB_PORT: String(s.port),
    ALLOWED_PRIVATE_HOSTS: s.privateHosts.join(','),
    MCP_ALLOWED_URL_DOMAINS: s.jiraHosts.join(','),
    WEB_IMAGE: images.web,
    WORKER_IMAGE: images.worker,
    MIGRATE_IMAGE: images.migrate,
  };
  if (s.mode === 'server' && s.domain && s.acmeEmail) {
    env.APP_DOMAIN = s.domain;
    env.ACME_EMAIL = s.acmeEmail;
  }
  if (s.oidc) {
    env.OIDC_PROVIDER = s.oidc.provider;
    env.OIDC_ISSUER = s.oidc.issuer;
    env.OIDC_CLIENT_ID = s.oidc.clientId;
    env.OIDC_CLIENT_SECRET = s.oidc.clientSecret;
  }
  if (s.registry) {
    env.OPERATOR_REGISTRY_USER = s.registry.user;
    env.OPERATOR_REGISTRY_TOKEN = s.registry.token;
  }
  return env;
}
