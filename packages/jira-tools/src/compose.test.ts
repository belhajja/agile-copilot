import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { MCP_ATLASSIAN_IMAGE } from './image';
import { MCP_ATLASSIAN_ENABLED_TOOLS, MCP_ATLASSIAN_READONLY_ENABLED_TOOLS } from './mcp-backend';

type Service = {
  image?: string;
  environment?: Record<string, string>;
  ports?: string[];
  depends_on?: Record<string, { condition?: string }>;
  mem_limit?: string;
  networks?: string[] | Record<string, unknown>;
};
const networksOf = (s: Service | undefined) =>
  Array.isArray(s?.networks) ? s.networks : Object.keys(s?.networks ?? { default: null });
const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
// `merge: true` resolves `<<: *anchor` like Docker Compose does.
const services = (file: string) =>
  (parse(read(file), { merge: true }) as { services: Record<string, Service> }).services;
const isMcpAtlassian = (s: Service) => !!s.image?.startsWith('ghcr.io/sooperset/mcp-atlassian');
const toolList = (s: Service | undefined) =>
  (s?.environment?.ENABLED_TOOLS ?? '').split(',').filter(Boolean).sort();

// The mcp-atlassian services must run the image the contract test checked, expose exactly their
// allowlisted tools, never carry operator Jira credentials, and never be reachable from outside
// the machine (dev: loopback) or the compose network (self-host).
describe.each(['docker-compose.yml', 'docker-compose.selfhost.yml'])('%s', (file) => {
  const all = services(file);
  const mcp = Object.entries(all).filter(([, s]) => isMcpAtlassian(s));

  it('pins the contract-tested image', () => {
    expect(mcp.length).toBeGreaterThan(0);
    for (const [, s] of mcp) expect(s.image).toBe(MCP_ATLASSIAN_IMAGE);
    // No other line names the image (e.g. a commented-out or unpinned copy).
    const images = [...read(file).matchAll(/ghcr\.io\/sooperset\/mcp-atlassian\S*/g)].map(
      (m) => m[0],
    );
    expect(new Set(images)).toEqual(new Set([MCP_ATLASSIAN_IMAGE]));
  });

  it('enables exactly the allowlisted tools on each instance', () => {
    for (const [, s] of mcp) {
      const readOnly = s.environment?.READ_ONLY_MODE === 'true';
      const expected = readOnly
        ? MCP_ATLASSIAN_READONLY_ENABLED_TOOLS
        : MCP_ATLASSIAN_ENABLED_TOOLS;
      expect(toolList(s)).toEqual([...expected].sort());
    }
    expect(toolList(all['mcp-atlassian'])).toEqual([...MCP_ATLASSIAN_ENABLED_TOOLS].sort());
  });

  it('keeps mcp-atlassian on its own network, away from the database', () => {
    // Its only SSRF guard is its own (unpinned) domain check: it must not reach Postgres.
    for (const [, s] of mcp) expect(networksOf(s)).toEqual(['mcp']);
    for (const [name, s] of Object.entries(all)) {
      if (!isMcpAtlassian(s) && name !== 'web') expect(networksOf(s)).not.toContain('mcp');
    }
  });

  it('serves per-request Cloud OAuth and data-center credentials only', () => {
    for (const [, s] of mcp) {
      expect(s.environment).toMatchObject({
        TRANSPORT: 'streamable-http',
        PORT: '8000',
        ATLASSIAN_OAUTH_ENABLE: 'true',
      });
    }
  });

  it('sets no global Jira credentials and no credential fallback', () => {
    // Parsed YAML: comments (which explain these rules) are not settings.
    expect(JSON.stringify(all)).not.toMatch(
      /ALLOW_GLOBAL_CRED_FALLBACK|JIRA_URL|JIRA_PERSONAL_TOKEN|JIRA_API_TOKEN|JIRA_USERNAME/,
    );
    // mcp-atlassian's own OAuth app/token settings would also be operator credentials (the web app
    // legitimately holds the OAuth client for "Connect with Atlassian").
    for (const [, s] of mcp) {
      expect(
        Object.keys(s.environment ?? {}).filter((k) =>
          /^(ATLASSIAN_OAUTH_(?!ENABLE$)|CONFLUENCE_)/.test(k),
        ),
      ).toEqual([]);
    }
  });
});

describe('docker-compose.yml (development)', () => {
  const all = services('docker-compose.yml');

  it('publishes mcp-atlassian on loopback only, on a port no other project uses', () => {
    expect(all['mcp-atlassian']?.ports).toEqual(['127.0.0.1:4060:8000']);
  });
});

describe('docker-compose.selfhost.yml', () => {
  const all = services('docker-compose.selfhost.yml');

  it('runs a shared instance and a read-only twin, neither published', () => {
    expect(isMcpAtlassian(all['mcp-atlassian'] ?? {})).toBe(true);
    expect(all['mcp-atlassian']?.environment?.READ_ONLY_MODE).toBeUndefined();
    expect(all['mcp-atlassian-readonly']?.environment?.READ_ONLY_MODE).toBe('true');
    for (const [, s] of Object.entries(all).filter(([, s]) => isMcpAtlassian(s))) {
      expect(s.ports).toBeUndefined();
      // A modest cap: a runaway sidecar must not starve the app and Postgres.
      expect(s.mem_limit).toBe('512m');
    }
  });

  it('lets only the web app reach mcp-atlassian', () => {
    expect(networksOf(all.web).sort()).toEqual(['default', 'mcp']);
  });

  it('points the web app at the internal service without depending on it', () => {
    expect(all.web?.environment?.MCP_ATLASSIAN_URL).toBe('http://mcp-atlassian:8000/mcp');
    // P3-R23: the dashboards keep working when the agent sidecar is down or cannot be pulled.
    for (const name of ['web', 'worker']) {
      expect(Object.keys(all[name]?.depends_on ?? {})).toEqual(['migrate']);
    }
  });

  it('never gives the web app or the worker the owner credentials', () => {
    for (const name of ['web', 'worker']) {
      expect(JSON.stringify(all[name]?.environment)).not.toMatch(
        /POSTGRES_PASSWORD|DATABASE_OWNER_URL|postgres:\/\/agile:/,
      );
    }
  });
});
