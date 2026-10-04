import { describe, expect, it } from 'vitest';
import { billingConfigOf, EnvError, langfuseConfigOf, parseServerEnv } from './env';

const valid = {
  DATABASE_URL: 'postgres://app_user:pw@localhost:5432/agile',
  BETTER_AUTH_SECRET: 's'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3000',
  ENCRYPTION_KEYS: `v1:${Buffer.alloc(32, 1).toString('base64')}`,
};

describe('parseServerEnv', () => {
  it('parses a minimal valid environment with defaults', () => {
    const env = parseServerEnv(valid);
    expect(env.DEPLOYMENT_MODE).toBe('selfhost');
    expect(env.NODE_ENV).toBe('development');
    expect(env.ALLOWED_PRIVATE_HOSTS).toEqual([]);
    expect(env.ATLASSIAN_OAUTH_CLIENT_ID).toBeUndefined();
  });

  it('treats empty strings (copied .env.example) as unset', () => {
    const env = parseServerEnv({
      ...valid,
      ALLOWED_PRIVATE_HOSTS: '',
      ATLASSIAN_OAUTH_CLIENT_ID: '',
      ATLASSIAN_OAUTH_CLIENT_SECRET: '',
    });
    expect(env.ATLASSIAN_OAUTH_CLIENT_ID).toBeUndefined();
    expect(env.ALLOWED_PRIVATE_HOSTS).toEqual([]);
  });

  it('reads the optional mcp-atlassian URL', () => {
    expect(parseServerEnv({ ...valid, MCP_ATLASSIAN_URL: '' }).MCP_ATLASSIAN_URL).toBeUndefined();
    expect(
      parseServerEnv({ ...valid, MCP_ATLASSIAN_URL: 'http://mcp-atlassian:8000/mcp' })
        .MCP_ATLASSIAN_URL,
    ).toBe('http://mcp-atlassian:8000/mcp');
    expect(() => parseServerEnv({ ...valid, MCP_ATLASSIAN_URL: 'not a url' })).toThrow(
      /MCP_ATLASSIAN_URL/,
    );
  });

  it('reads the read-only mcp-atlassian URL and the daily skill-run limit', () => {
    expect(parseServerEnv(valid)).toMatchObject({ SKILL_RUNS_DAILY_LIMIT: 50 });
    expect(parseServerEnv(valid).MCP_ATLASSIAN_READONLY_URL).toBeUndefined();
    expect(
      parseServerEnv({
        ...valid,
        MCP_ATLASSIAN_READONLY_URL: 'http://mcp-atlassian-readonly:8000/mcp',
        SKILL_RUNS_DAILY_LIMIT: '200',
      }),
    ).toMatchObject({
      MCP_ATLASSIAN_READONLY_URL: 'http://mcp-atlassian-readonly:8000/mcp',
      SKILL_RUNS_DAILY_LIMIT: 200,
    });
    expect(() => parseServerEnv({ ...valid, SKILL_RUNS_DAILY_LIMIT: '-1' })).toThrow(
      /SKILL_RUNS_DAILY_LIMIT/,
    );
  });

  it('reads the SSO settings and the password policy', () => {
    const sso = {
      ...valid,
      OIDC_ISSUER: 'https://id.example.com/realms/acme',
      OIDC_CLIENT_ID: 'agile',
      OIDC_CLIENT_SECRET: 'secret',
      PASSWORD_LOGIN: 'admin_only',
      BREAK_GLASS_EMAILS: ' Root@Example.com , ops@example.com,',
    };
    const env = parseServerEnv(sso);
    expect(env).toMatchObject({
      OIDC_PROVIDER: 'keycloak',
      OIDC_DISPLAY_NAME: 'SSO',
      PASSWORD_LOGIN: 'admin_only',
      BREAK_GLASS_EMAILS: ['root@example.com', 'ops@example.com'],
    });
    expect(parseServerEnv(valid)).toMatchObject({ PASSWORD_LOGIN: 'all', BREAK_GLASS_EMAILS: [] });
    expect(parseServerEnv(valid).OIDC_ISSUER).toBeUndefined();
    expect(() => parseServerEnv({ ...valid, OIDC_ISSUER: sso.OIDC_ISSUER })).toThrow(
      /OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET must be set together/,
    );
    // Without SSO, or without a break-glass account, nobody could sign in.
    expect(() => parseServerEnv({ ...valid, PASSWORD_LOGIN: 'admin_only' })).toThrow(
      /PASSWORD_LOGIN/,
    );
    expect(() => parseServerEnv({ ...sso, BREAK_GLASS_EMAILS: '' })).toThrow(/PASSWORD_LOGIN/);
    expect(() => parseServerEnv({ ...sso, BREAK_GLASS_EMAILS: 'not-an-email' })).toThrow(
      /BREAK_GLASS_EMAILS/,
    );
  });

  it('turns billing on only for SaaS deployments with Stripe configured', () => {
    const stripe = {
      STRIPE_SECRET_KEY: 'sk_test_1',
      STRIPE_WEBHOOK_SECRET: 'whsec_1',
      STRIPE_PRICE_TEAM: 'price_1',
    };
    expect(billingConfigOf(parseServerEnv({ ...valid, ...stripe }))).toBeNull();
    expect(
      billingConfigOf(parseServerEnv({ ...valid, ...stripe, DEPLOYMENT_MODE: 'saas' })),
    ).toEqual({
      secretKey: 'sk_test_1',
      webhookSecret: 'whsec_1',
      priceTeam: 'price_1',
      apiUrl: undefined,
    });
    expect(billingConfigOf(parseServerEnv({ ...valid, DEPLOYMENT_MODE: 'saas' }))).toBeNull();
    expect(() => parseServerEnv({ ...valid, STRIPE_SECRET_KEY: 'sk_test_1' })).toThrow(
      /STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRICE_TEAM/,
    );
  });

  it('traces to Langfuse only when both keys are set', () => {
    expect(langfuseConfigOf(parseServerEnv(valid))).toBeNull();
    expect(
      langfuseConfigOf(
        parseServerEnv({
          ...valid,
          LANGFUSE_PUBLIC_KEY: 'pk-lf-1',
          LANGFUSE_SECRET_KEY: 'sk-lf-1',
        }),
      ),
    ).toEqual({
      publicKey: 'pk-lf-1',
      secretKey: 'sk-lf-1',
      baseUrl: 'https://cloud.langfuse.com',
      environment: 'selfhost',
    });
    expect(() => parseServerEnv({ ...valid, LANGFUSE_PUBLIC_KEY: 'pk-lf-1' })).toThrow(
      /LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY/,
    );
  });

  it('requires https for URLs that receive secrets, except loopback and allowlisted hosts', () => {
    for (const key of ['OIDC_ISSUER', 'STRIPE_API_URL', 'LANGFUSE_BASE_URL']) {
      const withUrl = (url: string, extra: Record<string, string> = {}) => {
        const base: Record<string, string> = { ...valid, ...extra, [key]: url };
        if (key === 'OIDC_ISSUER') {
          base.OIDC_CLIENT_ID = 'agile';
          base.OIDC_CLIENT_SECRET = 'secret';
        }
        return parseServerEnv(base);
      };
      expect(() => withUrl('http://id.example.com/realm')).toThrow(new RegExp(`${key}.*https`));
      expect(() => withUrl('ftp://id.example.com')).toThrow(key);
      expect(() => withUrl('javascript:alert(1)')).toThrow(key);
      expect(() => withUrl('https://id.example.com/realm')).not.toThrow();
      expect(() => withUrl('http://127.0.0.1:4090')).not.toThrow();
      expect(() => withUrl('http://localhost:4100/realms/x')).not.toThrow();
      expect(() => withUrl('http://[::1]:4100')).not.toThrow();
      expect(() => withUrl('http://idp.corp.test')).toThrow(key);
      expect(() =>
        withUrl('http://idp.corp.test', { ALLOWED_PRIVATE_HOSTS: 'corp.test' }),
      ).not.toThrow();
    }
  });

  it('de-duplicates break-glass emails', () => {
    expect(parseServerEnv({ ...valid, BREAK_GLASS_EMAILS: 'A@x.io, a@x.io,b@x.io' })).toMatchObject(
      { BREAK_GLASS_EMAILS: ['a@x.io', 'b@x.io'] },
    );
  });

  it('never puts a configured value in the error text', () => {
    const marker = 'MARKER-s3cr3t-value';
    const keys = [
      'OIDC_PROVIDER',
      'OIDC_ISSUER',
      'OIDC_CLIENT_ID',
      'OIDC_CLIENT_SECRET',
      'OIDC_DISPLAY_NAME',
      'PASSWORD_LOGIN',
      'BREAK_GLASS_EMAILS',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_PRICE_TEAM',
      'STRIPE_API_URL',
      'LANGFUSE_PUBLIC_KEY',
      'LANGFUSE_SECRET_KEY',
      'LANGFUSE_BASE_URL',
      'MCP_RATE_LIMIT_PER_MINUTE',
    ];
    for (const key of keys) {
      let message = '';
      try {
        parseServerEnv({ ...valid, [key]: marker });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, key).not.toContain(marker);
    }
  });

  it('normalises the private host allowlist', () => {
    const env = parseServerEnv({
      ...valid,
      ALLOWED_PRIVATE_HOSTS: ' jira.corp.local, Ollama.Internal ,,',
    });
    expect(env.ALLOWED_PRIVATE_HOSTS).toEqual(['jira.corp.local', 'ollama.internal']);
  });

  it('lists every invalid key without echoing secret values', () => {
    const secret = 'too-short-secret-value';
    try {
      parseServerEnv({ ...valid, BETTER_AUTH_SECRET: secret, DATABASE_URL: undefined });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      const message = (e as Error).message;
      expect(message).toContain('BETTER_AUTH_SECRET');
      expect(message).toContain('DATABASE_URL');
      expect(message).not.toContain(secret);
    }
  });

  it('requires the Atlassian OAuth id and secret together', () => {
    expect(() => parseServerEnv({ ...valid, ATLASSIAN_OAUTH_CLIENT_ID: 'abc' })).toThrow(
      /ATLASSIAN_OAUTH_CLIENT_ID/,
    );
  });
});
