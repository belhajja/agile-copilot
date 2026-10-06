import { copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from './context';
import { type Docker, type RunOptions, type RunResult, servicesOf } from './docker';
import type { Mode } from './settings';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The files the operator image ships in /opt/operator/assets, copied from the repo. */
export async function repoAssets(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'operator-assets-'));
  await copyFile(
    join(REPO, 'docker-compose.selfhost.yml'),
    join(dir, 'docker-compose.selfhost.yml'),
  );
  await copyFile(join(REPO, 'docker-compose.server.yml'), join(dir, 'docker-compose.server.yml'));
  await copyFile(join(REPO, 'docker/postgres/init/01-app-role.sh'), join(dir, 'postgres-init.sh'));
  await copyFile(join(REPO, 'docker/caddy/Caddyfile'), join(dir, 'Caddyfile'));
  return dir;
}

/** A Docker call as a short command: `compose up -d`, `pull image`, ... */
export function commandOf(args: string[]): string {
  if (args[0] !== 'compose') return args.join(' ');
  const i = args.lastIndexOf('-f');
  return ['compose', ...args.slice(i + 2)].join(' ');
}

export type Responder = (
  cmd: string,
  args: string[],
  opts?: RunOptions,
) => Partial<RunResult> | undefined;

export function psLines(
  states: Record<string, { state: string; health?: string; exitCode?: number }>,
): string {
  return Object.entries(states)
    .map(([Service, s]) =>
      JSON.stringify({
        Service,
        State: s.state,
        Health: s.health ?? '',
        ExitCode: s.exitCode ?? 0,
      }),
    )
    .join('\n');
}

export function healthyPs(mode: Mode = 'local'): string {
  return psLines(
    Object.fromEntries(
      servicesOf(mode).map((service) => [
        service,
        service === 'migrate'
          ? { state: 'exited', exitCode: 0 }
          : service === 'caddy'
            ? { state: 'running' }
            : { state: 'running', health: 'healthy' },
      ]),
    ),
  );
}

/** Records every call; `compose ps` answers "all healthy" unless the responder says otherwise. */
export class FakeDocker implements Docker {
  readonly calls: { cmd: string; args: string[]; opts?: RunOptions }[] = [];
  constructor(
    private readonly respond: Responder = () => undefined,
    private readonly mode: Mode = 'local',
  ) {}

  async run(args: string[], opts?: RunOptions): Promise<RunResult> {
    const cmd = commandOf(args);
    this.calls.push({ cmd, args, opts });
    const r =
      this.respond(cmd, args, opts) ??
      (cmd.startsWith('compose ps') ? { stdout: healthyPs(this.mode) } : {});
    if (opts?.stdoutFile) await writeFile(opts.stdoutFile, r.stdout ?? 'dump');
    if (opts?.onStdout && r.stdout) opts.onStdout(r.stdout);
    const collected = opts?.stdoutFile || opts?.onStdout ? '' : (r.stdout ?? '');
    return { code: r.code ?? 0, stdout: collected, stderr: r.stderr ?? '' };
  }

  get commands(): string[] {
    return this.calls.map((c) => c.cmd);
  }
}

export async function tempContext(
  o: { respond?: Responder; mode?: Mode; ref?: string; answers?: string[]; confirm?: boolean } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'operator-data-'));
  const docker = new FakeDocker(o.respond, o.mode);
  const out: string[] = [];
  const answers = [...(o.answers ?? [])];
  let clock = Date.parse('2026-10-06T12:00:00Z');
  const ctx: Context = {
    dataDir,
    assetsDir: await repoAssets(),
    build: { ref: o.ref ?? 'v1.0.0', imageBase: 'registry.example.com/agile' },
    docker,
    out: (line) => out.push(line),
    prompt: {
      ask: async (_q, opts) => answers.shift() ?? opts?.default ?? '',
      confirm: async () => o.confirm ?? false,
    },
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
    healthTimeoutMs: 60_000,
  };
  return { ctx, docker, out, dataDir };
}
