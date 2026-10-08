import type { Context } from './context';
import { operatorImage } from './stack';

/**
 * Where the install folder is on the Docker host: what the updater service mounts as /data. In
 * the operator's own container that is the source of its /data mount (Docker gives a container no
 * other way to learn it); run directly on the host, the folder itself.
 */
export async function dataSource(
  ctx: Pick<Context, 'docker' | 'dataDir' | 'self'>,
): Promise<string> {
  if (ctx.self) {
    const r = await ctx.docker.run(['inspect', '--format', '{{json .Mounts}}', ctx.self]);
    if (r.code === 0) {
      try {
        const mounts = JSON.parse(r.stdout) as { Source?: string; Destination?: string }[];
        const own = mounts.find((m) => m.Destination === ctx.dataDir);
        if (own?.Source) return own.Source;
      } catch {
        // Not JSON: fall back to the folder's own path.
      }
    }
  }
  return ctx.dataDir;
}

/**
 * The .env values the updater service needs: this operator's image, the install folder on the
 * host and, unless already chosen, automatic upgrades on.
 */
export async function updaterEnv(
  ctx: Pick<Context, 'docker' | 'dataDir' | 'self' | 'build'>,
  env: Map<string, string> = new Map(),
): Promise<Record<string, string>> {
  return {
    OPERATOR_IMAGE: operatorImage(ctx.build),
    OPERATOR_DATA_SOURCE: env.get('OPERATOR_DATA_SOURCE') ?? (await dataSource(ctx)),
    AUTO_UPGRADE: env.get('AUTO_UPGRADE') ?? 'on',
  };
}
