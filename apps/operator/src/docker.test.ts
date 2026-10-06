import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Compose,
  createDocker,
  parsePs,
  registryLogin,
  servicesOf,
  stackHealth,
  waitHealthy,
} from './docker';
import { StepError } from './errors';
import { psLines, tempContext } from './testing';

describe('compose ps and health', () => {
  it('reads both the line-per-service and the array formats', () => {
    const line = psLines({ web: { state: 'running', health: 'healthy' } });
    expect(parsePs(line)).toEqual([
      { service: 'web', state: 'running', health: 'healthy', exitCode: 0 },
    ]);
    expect(parsePs(`[${line}]`)).toHaveLength(1);
    expect(parsePs('')).toEqual([]);
  });

  it('is ready when migrate exited 0 and the rest run healthy (caddy has no healthcheck)', () => {
    const services = servicesOf('server');
    const states = parsePs(
      psLines({
        postgres: { state: 'running', health: 'healthy' },
        migrate: { state: 'exited', exitCode: 0 },
        web: { state: 'running', health: 'healthy' },
        worker: { state: 'running', health: 'healthy' },
        'mcp-atlassian': { state: 'running', health: 'healthy' },
        'mcp-atlassian-readonly': { state: 'running', health: 'healthy' },
        caddy: { state: 'running' },
      }),
    );
    expect(stackHealth(states, services)).toEqual({ ready: true, failed: null });
  });

  it('names the service that failed: migrate exiting non-zero, an unhealthy service', () => {
    const services = servicesOf('local');
    expect(
      stackHealth(parsePs(psLines({ migrate: { state: 'exited', exitCode: 1 } })), services),
    ).toEqual({ ready: false, failed: 'migrate' });
    expect(
      stackHealth(parsePs(psLines({ web: { state: 'running', health: 'unhealthy' } })), services),
    ).toEqual({ ready: false, failed: 'web' });
    expect(
      stackHealth(parsePs(psLines({ web: { state: 'running', health: 'starting' } })), services),
    ).toEqual({ ready: false, failed: null });
  });

  it('waits until healthy, and gives up after the timeout', async () => {
    let calls = 0;
    const { ctx } = await tempContext({
      respond: (cmd) => {
        if (!cmd.startsWith('compose ps')) return undefined;
        calls++;
        return calls < 3
          ? { stdout: psLines({ web: { state: 'running', health: 'starting' } }) }
          : undefined;
      },
    });
    await waitHealthy(ctx, new Compose(ctx.docker, ctx.dataDir, 'local'), 'local');
    expect(calls).toBe(3);

    const slow = await tempContext({
      respond: (cmd) =>
        cmd.startsWith('compose ps')
          ? { stdout: psLines({ web: { state: 'created' } }) }
          : undefined,
    });
    await expect(
      waitHealthy(slow.ctx, new Compose(slow.ctx.docker, slow.ctx.dataDir, 'local'), 'local'),
    ).rejects.toThrow(StepError);
  });
});

describe('Compose', () => {
  it('always names the project, the folder, the .env and every compose file', async () => {
    const { ctx, docker } = await tempContext();
    await new Compose(ctx.docker, ctx.dataDir, 'server').run(['up', '-d']);
    const args = docker.calls[0]?.args ?? [];
    expect(args.slice(0, 3)).toEqual(['compose', '--project-name', 'agile-copilot']);
    expect(args.filter((a) => a === '-f')).toHaveLength(3);
    expect(args.slice(-2)).toEqual(['up', '-d']);
  });

  it('turns a failed command into a StepError naming the step', async () => {
    const { ctx } = await tempContext({ respond: () => ({ code: 1, stderr: 'boom' }) });
    await expect(
      new Compose(ctx.docker, ctx.dataDir, 'local').check('pull', ['pull']),
    ).rejects.toMatchObject({ step: 'pull', detail: 'boom' });
  });
});

describe('registryLogin', () => {
  it('sends the token on stdin, never as an argument', async () => {
    const { ctx, docker } = await tempContext();
    const env = new Map([
      ['OPERATOR_REGISTRY_USER', 'gitlab+deploy-token-1'],
      ['OPERATOR_REGISTRY_TOKEN', 'secret-token'],
    ]);
    await registryLogin(ctx, env);
    const call = docker.calls[0];
    expect(call?.args).toEqual([
      'login',
      'registry.example.com',
      '--username',
      'gitlab+deploy-token-1',
      '--password-stdin',
    ]);
    expect(call?.opts?.stdin).toBe('secret-token');
  });

  it('does nothing without credentials', async () => {
    const { ctx, docker } = await tempContext();
    await registryLogin(ctx, new Map());
    expect(docker.calls).toEqual([]);
  });
});

describe('realDocker error paths (no docker binary needed: runs node itself)', () => {
  it('rejects, rather than crashing, when stdout cannot be written', async () => {
    const docker = createDocker(process.execPath);
    // A directory is never a writable file, on any platform.
    await expect(docker.run(['-e', 'process.exit(0)'], { stdoutFile: tmpdir() })).rejects.toThrow();
  });

  it('rejects, rather than crashing, when stdin cannot be read', async () => {
    const docker = createDocker(process.execPath);
    const missing = join(tmpdir(), `operator-missing-${Date.now()}`);
    await expect(
      docker.run(['-e', 'setTimeout(() => process.exit(0), 50)'], { stdinFile: missing }),
    ).rejects.toThrow();
  });

  it('rejects, rather than crashing, when the binary itself is missing', async () => {
    const docker = createDocker('operator-no-such-binary');
    await expect(docker.run(['version'])).rejects.toThrow();
  });

  it('streams stderr to onStderr instead of collecting it', async () => {
    const docker = createDocker(process.execPath);
    const chunks: string[] = [];
    const result = await docker.run(['-e', 'process.stderr.write("oops\\n")'], {
      onStderr: (c) => chunks.push(c),
    });
    expect(chunks.join('')).toBe('oops\n');
    expect(result.stderr).toBe('');
  });

  it("ignores a broken stdin pipe and resolves with the child's real exit code", async () => {
    const docker = createDocker(process.execPath);
    // More than any OS pipe buffer: writing it to a child that never reads stdin and exits
    // immediately is guaranteed to hit a broken pipe.
    const big = 'x'.repeat(10 * 1024 * 1024);
    const result = await docker.run(['-e', 'process.exit(0)'], { stdin: big });
    expect(result.code).toBe(0);
  });
});
