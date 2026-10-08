import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  composeFiles,
  imagesFor,
  isRelease,
  operatorImage,
  refSlug,
  renderOverride,
  writeStack,
} from './stack';
import { repoAssets } from './testing';

describe('versions and images', () => {
  it('pins release images by tag and other refs by snapshot slug', () => {
    expect(isRelease('v1.4.0')).toBe(true);
    expect(isRelease('1.4.0-rc.1')).toBe(true);
    expect(isRelease('develop')).toBe(false);
    expect(refSlug('Feat/Operator_X')).toBe('feat-operator-x');
    expect(imagesFor({ ref: 'v1.4.0', imageBase: 'r/p' }).web).toBe('r/p/web:v1.4.0');
    expect(operatorImage({ ref: 'v1.4.0', imageBase: 'r/p' })).toBe('r/p/operator:v1.4.0');
    expect(operatorImage({ ref: 'develop', imageBase: 'r/p' })).toBe(
      'r/p/operator/snapshot:develop',
    );
    expect(imagesFor({ ref: 'develop', imageBase: 'r/p' }).migrate).toBe(
      'r/p/migrate/snapshot:develop',
    );
  });

  it('orders versions numerically', () => {
    expect(compareVersions('v1.10.0', 'v1.9.3')).toBeGreaterThan(0);
    expect(compareVersions('1.4.0', 'v1.4.0')).toBe(0);
    expect(compareVersions('v1.3.9', 'v1.4.0')).toBeLessThan(0);
  });
});

describe('the compose override', () => {
  it('injects the init script as an inline config, escaping $ for Compose', () => {
    const yaml = renderOverride('local', {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose interpolation, not a JS template
      pgInit: '#!/bin/sh\r\necho "${APP_DB_PASSWORD}"\r\n',
      caddyfile: '{$APP_DOMAIN}',
    });
    expect(yaml).toContain('      echo "$${APP_DB_PASSWORD}"');
    expect(yaml).not.toContain('\r');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose interpolation, not a JS template
    expect(yaml).toContain('127.0.0.1:${WEB_PORT:-3000}:3000');
    expect(yaml).not.toContain('caddy');
  });

  it('runs the updater from the operator image, with the Docker socket and the install folder', () => {
    for (const mode of ['local', 'server'] as const) {
      const yaml = renderOverride(mode, { pgInit: 'x', caddyfile: 'y' });
      expect(yaml).toContain('  updater:');
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose interpolation, not a JS template
      expect(yaml).toContain('    image: ${OPERATOR_IMAGE:?set OPERATOR_IMAGE}');
      expect(yaml).toContain('    command: [watch]');
      expect(yaml).toContain('    restart: unless-stopped');
      expect(yaml).toContain('      - /var/run/docker.sock:/var/run/docker.sock');
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose interpolation, not a JS template
      expect(yaml).toContain('      - ${OPERATOR_DATA_SOURCE:?set OPERATOR_DATA_SOURCE}:/data');
    }
  });

  it('adds the Caddyfile on a server and publishes nothing from web', () => {
    const yaml = renderOverride('server', { pgInit: 'x', caddyfile: '\t{$APP_DOMAIN} {\n}' });
    expect(yaml).toContain('target: /etc/caddy/Caddyfile');
    expect(yaml).toContain('      \t{$$APP_DOMAIN} {');
    expect(yaml).not.toContain('127.0.0.1');
    expect(composeFiles('server')).toEqual([
      'docker-compose.selfhost.yml',
      'docker-compose.server.yml',
      'compose.operator.yml',
    ]);
  });

  it('writes the compose files into /data/compose', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'operator-stack-'));
    await writeStack(dataDir, 'server', await repoAssets());
    const override = await readFile(join(dataDir, 'compose', 'compose.operator.yml'), 'utf8');
    expect(override).toContain('CREATE ROLE app_user');
    await readFile(join(dataDir, 'compose', 'docker-compose.server.yml'), 'utf8');
  });
});
