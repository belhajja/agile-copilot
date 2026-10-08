import type { Compose, Docker } from './docker';
import type { Images } from './stack';

/** The services that run the app's own images (the others are third-party, pinned images). */
export const APP_SERVICES = ['migrate', 'web', 'worker'] as const;
export type AppService = (typeof APP_SERVICES)[number];

const bare = (id: string) => id.trim().replace(/^sha256:/, '');

/** The 12-character form Docker prints. */
export const shortId = (id: string) => bare(id).slice(0, 12);

/** Whether two image IDs are the same image (one of them may be Docker's short form). */
export function sameImage(a: string, b: string): boolean {
  const [x, y] = [bare(a), bare(b)];
  const n = Math.min(x.length, y.length);
  return n >= 12 && x.slice(0, n) === y.slice(0, n);
}

const CONTAINER = /-(migrate|web|worker)-\d+$/;

/**
 * The image ID each app container was created from (`compose images`), by service. A service
 * without a container is left out; a failing command gives an empty map (nothing is known to run).
 */
export async function runningImages(compose: Compose): Promise<Map<AppService, string>> {
  const r = await compose.run(['images', '--format', 'json']);
  const found = new Map<AppService, string>();
  const text = r.stdout.trim();
  if (r.code !== 0 || !text) return found;
  const rows = (
    text.startsWith('[')
      ? JSON.parse(text)
      : text
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
  ) as { ContainerName?: string; ID?: string }[];
  for (const row of rows) {
    const service = CONTAINER.exec(row.ContainerName ?? '')?.[1] as AppService | undefined;
    if (service && row.ID) found.set(service, row.ID);
  }
  return found;
}

/** The ID of the image `ref` points to on this host, or null when it is not here. */
export async function imageId(docker: Docker, ref: string): Promise<string | null> {
  const r = await docker.run(['image', 'inspect', '--format', '{{.Id}}', ref]);
  const id = r.stdout.trim();
  return r.code === 0 && id ? id : null;
}

/** The IDs `images` point to on this host (after a pull: what the registry has now). */
export async function localImages(
  docker: Docker,
  images: Images,
): Promise<Map<AppService, string>> {
  const found = new Map<AppService, string>();
  for (const service of APP_SERVICES) {
    const id = await imageId(docker, images[service]);
    if (id) found.set(service, id);
  }
  return found;
}

/** Every app service runs exactly the image `latest` holds for it. */
export const runsLatest = (
  running: Map<AppService, string>,
  latest: Map<AppService, string>,
): boolean =>
  APP_SERVICES.every((s) => {
    const [a, b] = [running.get(s), latest.get(s)];
    return a !== undefined && b !== undefined && sameImage(a, b);
  });
