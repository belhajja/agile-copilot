import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import type { Context } from './context';
import { StepError } from './errors';
import type { Mode } from './settings';
import { composeFiles, PROJECT } from './stack';
import { pathsOf } from './state';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  stdin?: string;
  stdinFile?: string;
  /** Stdout goes to this file (created 0600) instead of `RunResult.stdout`. */
  stdoutFile?: string;
  /** Stdout is streamed here instead of collected. */
  onStdout?: (chunk: string) => void;
}

export interface Docker {
  run(args: string[], opts?: RunOptions): Promise<RunResult>;
}

/**
 * The host's Docker through the CLI. Arguments as an array: nothing goes through a shell.
 *
 * File-stream errors (a full disk, a missing stdin file) and a broken stdin pipe reject or
 * resolve the run instead of crashing the process; the promise settles exactly once.
 */
export function createDocker(command = 'docker'): Docker {
  return {
    run(args, opts = {}) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          fn();
        };

        const child = spawn(command, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';

        const file = opts.stdoutFile ? createWriteStream(opts.stdoutFile, { mode: 0o600 }) : null;
        const written = file
          ? new Promise<void>((r) => file.once('close', () => r()))
          : Promise.resolve();
        file?.on('error', (err) => {
          file.destroy();
          settle(() => reject(err));
        });

        if (file) child.stdout.pipe(file);
        else {
          child.stdout.on('data', (d: Buffer) => {
            if (opts.onStdout) opts.onStdout(d.toString());
            else stdout += d.toString();
          });
        }
        child.stdout.on('error', () => {});

        child.stderr.on('data', (d: Buffer) => {
          stderr += d.toString();
        });
        child.stderr.on('error', () => {});

        let input: ReturnType<typeof createReadStream> | null = null;
        child.stdin.on('error', (err) => {
          input?.destroy();
          // The child may exit before reading everything we sent it; its exit code is the
          // real outcome, not this broken pipe (reported as EPIPE, or EOF on Windows).
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'EPIPE' && code !== 'EOF') settle(() => reject(err));
        });

        if (opts.stdinFile) {
          input = createReadStream(opts.stdinFile);
          input.on('error', (err) => {
            input?.destroy();
            child.stdin.end();
            settle(() => reject(err));
          });
          input.pipe(child.stdin);
        } else {
          child.stdin.end(opts.stdin ?? '');
        }

        child.on('error', (err) => {
          file?.destroy();
          input?.destroy();
          settle(() => reject(err));
        });
        child.on('close', async (code) => {
          await written;
          settle(() => resolve({ code: code ?? 1, stdout, stderr }));
        });
      });
    },
  };
}

export const realDocker: Docker = createDocker();

/** `docker compose` for the stack in a data folder: always the same project, files and .env. */
export class Compose {
  constructor(
    private readonly docker: Docker,
    private readonly dataDir: string,
    private readonly mode: Mode,
  ) {}

  private args(rest: string[]): string[] {
    const p = pathsOf(this.dataDir);
    return [
      'compose',
      '--project-name',
      PROJECT,
      '--project-directory',
      p.compose,
      '--env-file',
      p.env,
      ...composeFiles(this.mode).flatMap((f) => ['-f', join(p.compose, f)]),
      ...rest,
    ];
  }

  run(rest: string[], opts?: RunOptions): Promise<RunResult> {
    return this.docker.run(this.args(rest), opts);
  }

  async check(step: string, rest: string[], opts?: RunOptions): Promise<RunResult> {
    const r = await this.run(rest, opts);
    if (r.code !== 0) throw new StepError(step, r.stderr.trim());
    return r;
  }
}

export interface ServiceState {
  service: string;
  state: string;
  health: string;
  exitCode: number;
}

/** `docker compose ps --format json`: one object per line (Compose 2.21+) or one array. */
export function parsePs(stdout: string): ServiceState[] {
  const text = stdout.trim();
  if (!text) return [];
  const rows = (
    text.startsWith('[')
      ? JSON.parse(text)
      : text
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
  ) as { Service: string; State: string; Health?: string; ExitCode?: number }[];
  return rows.map((r) => ({
    service: r.Service,
    state: r.State,
    health: r.Health ?? '',
    exitCode: r.ExitCode ?? 0,
  }));
}

const BASE_SERVICES = [
  'postgres',
  'migrate',
  'web',
  'worker',
  'mcp-atlassian',
  'mcp-atlassian-readonly',
] as const;

export function servicesOf(mode: Mode): readonly string[] {
  return mode === 'server' ? [...BASE_SERVICES, 'caddy'] : BASE_SERVICES;
}

/**
 * Ready: the one-shot migrate exited 0, every other service runs and is healthy (or has no
 * healthcheck). `failed` names a service that will not get there by waiting.
 */
export function stackHealth(
  states: ServiceState[],
  services: readonly string[],
): { ready: boolean; failed: string | null } {
  let ready = true;
  for (const service of services) {
    const s = states.find((x) => x.service === service);
    if (!s) {
      ready = false;
      continue;
    }
    if (service === 'migrate') {
      if (s.state === 'exited' && s.exitCode !== 0) return { ready: false, failed: service };
      if (s.state !== 'exited') ready = false;
      continue;
    }
    if (s.state === 'exited' || s.state === 'dead' || s.health === 'unhealthy') {
      return { ready: false, failed: service };
    }
    if (s.state !== 'running' || (s.health !== '' && s.health !== 'healthy')) ready = false;
  }
  return { ready, failed: null };
}

export async function waitHealthy(
  ctx: Pick<Context, 'now' | 'sleep' | 'healthTimeoutMs'>,
  compose: Compose,
  mode: Mode,
): Promise<void> {
  const deadline = ctx.now().getTime() + ctx.healthTimeoutMs;
  for (;;) {
    const ps = await compose.check('status', ['ps', '-a', '--format', 'json']);
    const health = stackHealth(parsePs(ps.stdout), servicesOf(mode));
    if (health.failed) throw new StepError('health', `${health.failed} did not start`);
    if (health.ready) return;
    if (ctx.now().getTime() >= deadline) {
      throw new StepError('health', 'the services were not healthy in time');
    }
    await ctx.sleep(3000);
  }
}

/** Logs in with the deploy token kept in .env (if any); the token goes through stdin. */
export async function registryLogin(
  ctx: Pick<Context, 'docker' | 'build'>,
  env: Map<string, string>,
): Promise<void> {
  const user = env.get('OPERATOR_REGISTRY_USER');
  const token = env.get('OPERATOR_REGISTRY_TOKEN');
  if (!user || !token) return;
  const host = ctx.build.imageBase.split('/')[0] ?? '';
  const r = await ctx.docker.run(['login', host, '--username', user, '--password-stdin'], {
    stdin: token,
  });
  if (r.code !== 0) throw new StepError('registry login', 'the registry refused the deploy token');
}
