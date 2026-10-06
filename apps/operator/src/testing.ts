import { copyFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
