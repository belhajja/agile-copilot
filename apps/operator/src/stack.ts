import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Mode } from './settings';

export const PROJECT = 'agile-copilot';
export const OVERRIDE_FILE = 'compose.operator.yml';

/** What this operator was built from: its ref (tag or branch) and where the images live. */
export interface Build {
  ref: string;
  imageBase: string;
}

export interface Images {
  web: string;
  worker: string;
  migrate: string;
}

const RELEASE = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export const isRelease = (ref: string) => RELEASE.test(ref);

/** GitLab's CI_COMMIT_REF_SLUG: lowercased, non-alphanumerics to "-", 63 characters at most. */
export function refSlug(ref: string): string {
  return ref
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .slice(0, 63)
    .replace(/^-+|-+$/g, '');
}

export function imagesFor(build: Build): Images {
  const image = (service: string) =>
    isRelease(build.ref)
      ? `${build.imageBase}/${service}:${build.ref}`
      : `${build.imageBase}/${service}/snapshot:${refSlug(build.ref)}`;
  return { web: image('web'), worker: image('worker'), migrate: image('migrate') };
}

/** The operator's own image for this build: what the updater service runs. */
export function operatorImage(build: Build): string {
  return isRelease(build.ref)
    ? `${build.imageBase}/operator:${build.ref}`
    : `${build.imageBase}/operator/snapshot:${refSlug(build.ref)}`;
}

/** Compares release versions by their numbers (a leading "v" and any suffix ignored). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (/^v?(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1).map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function composeFiles(mode: Mode): string[] {
  return [
    'docker-compose.selfhost.yml',
    ...(mode === 'server' ? ['docker-compose.server.yml'] : []),
    OVERRIDE_FILE,
  ];
}

/** Compose interpolates `$` in configs content: `$$` keeps a literal one. */
export const escapeCompose = (text: string) => text.split('$').join('$$');

const block = (text: string, indent: string) =>
  escapeCompose(text)
    .replace(/\r\n/g, '\n')
    .replace(/\n+$/, '')
    .split('\n')
    .map((line) => (line ? `${indent}${line}` : ''))
    .join('\n');

/**
 * The operator's override: images pinned from .env, nothing built, and the files the compose
 * files bind-mount from the repo (Postgres init script, Caddyfile) given as inline configs
 * instead, so the stack needs no host path shared with the operator's container.
 */
export function renderOverride(mode: Mode, assets: { pgInit: string; caddyfile: string }): string {
  const lines = [
    '# Written by the operator: image versions come from .env (WEB_IMAGE, WORKER_IMAGE,',
    '# MIGRATE_IMAGE); files the stack needs are inline configs.',
    'services:',
    '  postgres:',
    '    volumes: !override',
    '      - pgdata:/var/lib/postgresql/data',
    '    configs:',
    '      - source: pg-init',
    '        target: /docker-entrypoint-initdb.d/01-app-role.sh',
    '        mode: 0555',
    '  migrate:',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose interpolation, not a JS template
    '    image: ${MIGRATE_IMAGE:?set MIGRATE_IMAGE}',
    '    build: !reset null',
    '  web:',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose interpolation, not a JS template
    '    image: ${WEB_IMAGE:?set WEB_IMAGE}',
    '    build: !reset null',
    ...(mode === 'local'
      ? [
          '    ports: !override',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose interpolation, not a JS template
          '      - 127.0.0.1:${WEB_PORT:-3000}:3000',
        ]
      : []),
    '  worker:',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose interpolation, not a JS template
    '    image: ${WORKER_IMAGE:?set WORKER_IMAGE}',
    '    build: !reset null',
    // Automatic upgrades: checks the registry every AUTO_UPGRADE_INTERVAL_MINUTES and runs a
    // freshly pulled operator's `upgrade` (a no-op when nothing is newer).
    '  updater:',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose interpolation, not a JS template
    '    image: ${OPERATOR_IMAGE:?set OPERATOR_IMAGE}',
    '    command: [watch]',
    '    restart: unless-stopped',
    '    volumes:',
    '      - /var/run/docker.sock:/var/run/docker.sock',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose interpolation, not a JS template
    '      - ${OPERATOR_DATA_SOURCE:?set OPERATOR_DATA_SOURCE}:/data',
    ...(mode === 'server'
      ? [
          '  caddy:',
          '    volumes: !override',
          '      - caddy_data:/data',
          '      - caddy_config:/config',
          '    configs:',
          '      - source: caddyfile',
          '        target: /etc/caddy/Caddyfile',
        ]
      : []),
    'configs:',
    '  pg-init:',
    '    content: |',
    block(assets.pgInit, '      '),
    ...(mode === 'server'
      ? ['  caddyfile:', '    content: |', block(assets.caddyfile, '      ')]
      : []),
  ];
  return `${lines.join('\n')}\n`;
}

export async function writeStack(dataDir: string, mode: Mode, assetsDir: string): Promise<void> {
  const dir = join(dataDir, 'compose');
  await mkdir(dir, { recursive: true });
  for (const file of composeFiles(mode).filter((f) => f !== OVERRIDE_FILE)) {
    await copyFile(join(assetsDir, file), join(dir, file));
  }
  const pgInit = await readFile(join(assetsDir, 'postgres-init.sh'), 'utf8');
  const caddyfile = await readFile(join(assetsDir, 'Caddyfile'), 'utf8');
  await writeFile(join(dir, OVERRIDE_FILE), renderOverride(mode, { pgInit, caddyfile }));
}
