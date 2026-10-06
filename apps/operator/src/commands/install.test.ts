import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../env-file';
import { UsageError } from '../errors';
import { SettingsError } from '../settings';
import { readState } from '../state';
import { tempContext } from '../testing';
import { install } from './install';

describe('install', () => {
  it('writes the stack, starts it and waits for health', async () => {
    const { ctx, docker, out, dataDir } = await tempContext();
    await install(
      ctx,
      { port: '3100', 'jira-hosts': 'jira.corp.local' },
      { yes: true, resume: false },
    );
    expect(docker.commands).toEqual([
      'compose pull',
      'compose up -d',
      'compose ps -a --format json',
    ]);
    const env = parseEnv(await readFile(join(dataDir, '.env'), 'utf8'));
    expect(env.get('WEB_IMAGE')).toBe('registry.example.com/agile/web:v1.0.0');
    expect(env.get('MCP_ALLOWED_URL_DOMAINS')).toBe('jira.corp.local');
    expect(env.get('BETTER_AUTH_URL')).toBe('http://localhost:3100');
    if (process.platform !== 'win32') {
      expect((await stat(join(dataDir, '.env'))).mode & 0o777).toBe(0o600);
    }
    expect(await readState(dataDir)).toMatchObject({ version: 'v1.0.0', mode: 'local' });
    expect(out.at(-2)).toMatch(/http:\/\/localhost:3100/);
    // No secret in the output.
    const secret = env.get('POSTGRES_PASSWORD') ?? '';
    expect(out.join('\n')).not.toContain(secret);
  });

  it('logs in first when a deploy token is given', async () => {
    const { ctx, docker } = await tempContext();
    await install(
      ctx,
      { 'registry-user': 'gitlab+deploy-token-1', 'registry-token': 'tok' },
      { yes: true, resume: false },
    );
    expect(docker.commands[0]).toMatch(/^login registry\.example\.com/);
  });

  it('refuses a folder that already has an install', async () => {
    const { ctx } = await tempContext();
    await install(ctx, {}, { yes: true, resume: false });
    await expect(install(ctx, {}, { yes: true, resume: false })).rejects.toBeInstanceOf(UsageError);
  });

  it('writes nothing when a setting is refused', async () => {
    const { ctx, dataDir } = await tempContext();
    await expect(install(ctx, { port: '99999' }, { yes: true, resume: false })).rejects.toThrow();
    expect(await readState(dataDir)).toBeNull();
  });

  it('stops what it started when the stack does not come up', async () => {
    const { ctx, docker } = await tempContext({
      respond: (cmd) =>
        cmd === 'compose up -d' ? { code: 1, stderr: 'port is already allocated' } : undefined,
    });
    await expect(install(ctx, {}, { yes: true, resume: false })).rejects.toMatchObject({
      step: 'start',
    });
    expect(docker.commands.at(-1)).toBe('compose stop');
  });

  it('reports the original failure when the stop after it fails too', async () => {
    const { ctx } = await tempContext();
    ctx.docker = {
      run: async (args) => {
        if (args.includes('stop')) throw new Error('docker went away');
        return args.includes('up')
          ? { code: 1, stdout: '', stderr: 'port is already allocated' }
          : { code: 0, stdout: '', stderr: '' };
      },
    };
    await expect(install(ctx, {}, { yes: true, resume: false })).rejects.toMatchObject({
      step: 'start',
      detail: 'port is already allocated',
    });
  });

  it('resume keeps the secrets of the first attempt', async () => {
    let fail = true;
    const { ctx, dataDir } = await tempContext({
      respond: (cmd) => (cmd === 'compose up -d' && fail ? { code: 1, stderr: 'x' } : undefined),
    });
    await expect(install(ctx, {}, { yes: true, resume: false })).rejects.toThrow();
    const first = parseEnv(await readFile(join(dataDir, '.env'), 'utf8')).get('POSTGRES_PASSWORD');
    fail = false;
    await install(ctx, {}, { yes: true, resume: true });
    const second = parseEnv(await readFile(join(dataDir, '.env'), 'utf8')).get('POSTGRES_PASSWORD');
    expect(second).toBe(first);
  });

  it('says how to give a deploy token when the pull is refused', async () => {
    const { ctx, out } = await tempContext({
      respond: (cmd) => (cmd === 'compose pull' ? { code: 1, stderr: 'denied' } : undefined),
    });
    await expect(install(ctx, {}, { yes: true, resume: false })).rejects.toMatchObject({
      step: 'pull',
    });
    expect(out.join('\n')).toMatch(
      /install --resume --registry-user \S+ --registry-token \S+.*OPERATOR_REGISTRY_TOKEN/,
    );
  });

  it('resume takes new registry credentials and logs in with them', async () => {
    let fail = true;
    const { ctx, docker, dataDir, out } = await tempContext({
      respond: (cmd) =>
        cmd === 'compose pull' && fail ? { code: 1, stderr: 'denied' } : undefined,
    });
    await expect(install(ctx, {}, { yes: true, resume: false })).rejects.toThrow();
    const before = parseEnv(await readFile(join(dataDir, '.env'), 'utf8'));
    fail = false;
    docker.calls.length = 0;
    out.length = 0;
    await install(
      ctx,
      { 'registry-user': 'gitlab+deploy-token-2', 'registry-token': 'tok2', port: '4000' },
      { yes: true, resume: true },
    );
    const env = parseEnv(await readFile(join(dataDir, '.env'), 'utf8'));
    expect(env.get('OPERATOR_REGISTRY_USER')).toBe('gitlab+deploy-token-2');
    expect(env.get('OPERATOR_REGISTRY_TOKEN')).toBe('tok2');
    // nothing else changes on resume
    expect(env.get('POSTGRES_PASSWORD')).toBe(before.get('POSTGRES_PASSWORD'));
    expect(env.get('WEB_PORT')).toBe('3000');
    expect(out.join('\n')).toMatch(/ignored/);
    expect(docker.calls[0]?.args).toEqual([
      'login',
      'registry.example.com',
      '--username',
      'gitlab+deploy-token-2',
      '--password-stdin',
    ]);
    expect(docker.calls[0]?.opts?.stdin).toBe('tok2');
  });

  it('resume refuses a registry user without a token, .env untouched', async () => {
    const { ctx, dataDir } = await tempContext({
      respond: (cmd) => (cmd === 'compose pull' ? { code: 1, stderr: 'denied' } : undefined),
    });
    await expect(install(ctx, {}, { yes: true, resume: false })).rejects.toThrow();
    const before = await readFile(join(dataDir, '.env'), 'utf8');
    await expect(
      install(ctx, { 'registry-user': 'gitlab+deploy-token-2' }, { yes: true, resume: true }),
    ).rejects.toBeInstanceOf(SettingsError);
    expect(await readFile(join(dataDir, '.env'), 'utf8')).toBe(before);
  });
});
