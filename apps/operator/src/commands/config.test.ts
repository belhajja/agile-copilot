import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../env-file';
import { UsageError } from '../errors';
import { SettingsError } from '../settings';
import { tempContext } from '../testing';
import { config } from './config';
import { install } from './install';

describe('config', () => {
  it('changes one setting and recreates only the services that read it', async () => {
    const { ctx, docker, dataDir } = await tempContext();
    await install(ctx, {}, { yes: true, resume: false });
    docker.calls.length = 0;
    await config(ctx, 'jira-hosts', 'Jira.Corp.local,portail.agir.orange.com');
    const env = parseEnv(await readFile(join(dataDir, '.env'), 'utf8'));
    expect(env.get('MCP_ALLOWED_URL_DOMAINS')).toBe('jira.corp.local,portail.agir.orange.com');
    expect(docker.commands[0]).toBe('compose up -d mcp-atlassian mcp-atlassian-readonly worker');
  });

  it('moves the port and the sign-in URL together', async () => {
    const { ctx, dataDir } = await tempContext();
    await install(ctx, {}, { yes: true, resume: false });
    await config(ctx, 'port', '3200');
    const env = parseEnv(await readFile(join(dataDir, '.env'), 'utf8'));
    expect([env.get('WEB_PORT'), env.get('BETTER_AUTH_URL')]).toEqual([
      '3200',
      'http://localhost:3200',
    ]);
  });

  it('refuses unknown keys, keys of the other mode and bad values, .env untouched', async () => {
    const { ctx, dataDir } = await tempContext();
    await install(ctx, {}, { yes: true, resume: false });
    const envPath = join(dataDir, '.env');
    const before = await readFile(envPath, 'utf8');
    await expect(config(ctx, 'POSTGRES_PASSWORD', 'x')).rejects.toBeInstanceOf(UsageError);
    expect(await readFile(envPath, 'utf8')).toBe(before);
    await expect(config(ctx, 'domain', 'c.example.com')).rejects.toBeInstanceOf(UsageError);
    expect(await readFile(envPath, 'utf8')).toBe(before);
    await expect(config(ctx, 'private-hosts', 'a b')).rejects.toBeInstanceOf(SettingsError);
    expect(await readFile(envPath, 'utf8')).toBe(before);
  });
});
