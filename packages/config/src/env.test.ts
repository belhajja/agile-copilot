import { describe, expect, it } from 'vitest';
import { EnvError, parseServerEnv } from './env';

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
