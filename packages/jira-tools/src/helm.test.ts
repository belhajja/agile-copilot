import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';
import { MCP_ATLASSIAN_IMAGE } from './image';
import { MCP_ATLASSIAN_ENABLED_TOOLS, MCP_ATLASSIAN_READONLY_ENABLED_TOOLS } from './mcp-backend';

const chart = (file: string) =>
  readFileSync(new URL(`../../../deploy/helm/agile-copilot/${file}`, import.meta.url), 'utf8');
const template = (file: string) => chart(`templates/${file}`);
const values = parse(chart('values.yaml')) as {
  mcpAtlassian: { image: string; enabledTools: string; readonlyEnabledTools: string };
  secrets: { existingSecret: string };
  networkPolicy: { enabled: boolean };
};
const list = (s: string) => s.split(',').filter(Boolean).sort();

// The Helm chart runs the same contract-tested mcp-atlassian as the compose files, with the same
// tool allowlists, and carries no secret values.
describe('Helm chart (deploy/helm/agile-copilot)', () => {
  it('pins the contract-tested mcp-atlassian image and its tool allowlists', () => {
    expect(values.mcpAtlassian.image).toBe(MCP_ATLASSIAN_IMAGE);
    expect(list(values.mcpAtlassian.enabledTools)).toEqual([...MCP_ATLASSIAN_ENABLED_TOOLS].sort());
    expect(list(values.mcpAtlassian.readonlyEnabledTools)).toEqual(
      [...MCP_ATLASSIAN_READONLY_ENABLED_TOOLS].sort(),
    );
  });

  it('reads secrets from an existing Secret only, and enables the network policies', () => {
    expect(values.secrets.existingSecret).toBe('');
    expect(values.networkPolicy.enabled).toBe(true);
    const templates = ['web.yaml', 'worker.yaml', 'migrate-job.yaml', 'mcp-atlassian.yaml'].map(
      template,
    );
    // No template creates a Secret; credentials never pass through Helm values.
    expect(templates.join('\n')).not.toMatch(/kind:\s*Secret\b/);
    // Only the migration job gets the owner credentials.
    const ownerUrl = /"key" "DATABASE_OWNER_URL"|name:\s*DATABASE_OWNER_URL/;
    expect(template('migrate-job.yaml')).toMatch(ownerUrl);
    for (const file of ['web.yaml', 'worker.yaml', '_helpers.tpl']) {
      expect(template(file)).not.toMatch(ownerUrl);
    }
  });

  it('never gives mcp-atlassian operator Jira credentials', () => {
    const mcp = template('mcp-atlassian.yaml');
    expect(mcp).not.toMatch(
      /name:\s*(JIRA_URL|JIRA_USERNAME|JIRA_API_TOKEN|JIRA_PERSONAL_TOKEN|ALLOW_GLOBAL_CRED_FALLBACK)\b/,
    );
  });
});

const repoFile = (file: string) =>
  readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');

// Under `runAsNonRoot` the kubelet only starts an image whose user it can verify: a numeric one.
describe('apps/web/Dockerfile', () => {
  const dockerfile = repoFile('apps/web/Dockerfile');
  const stages = dockerfile.split(/^(?=FROM )/m).filter((s) => s.startsWith('FROM '));
  const nameOf = (stage: string) => /^FROM \S+ AS (\S+)/.exec(stage)?.[1] ?? '';
  const used = new Set(
    stages.flatMap((s) => [
      ...[...s.matchAll(/--from=(\S+)/g)].map((m) => m[1]),
      /^FROM (\S+)/.exec(s)?.[1],
    ]),
  );
  // Final images (runner, worker, migrate): stages no other stage builds on.
  const finals = stages.filter((s) => !used.has(nameOf(s)));

  it('runs every image the chart deploys as the numeric user the chart expects', () => {
    expect(finals.map(nameOf).sort()).toEqual(['migrate', 'runner', 'worker']);
    const podUser = (parse(chart('values.yaml')) as { podSecurityContext: { runAsUser: number } })
      .podSecurityContext.runAsUser;
    for (const stage of finals) {
      const users = [...stage.matchAll(/^USER (.+)$/gm)].map((m) => m[1]);
      expect(users.at(-1), nameOf(stage)).toBe(`${podUser}:${podUser}`);
    }
    // No user name anywhere: names cannot be checked against runAsNonRoot.
    for (const [, user] of dockerfile.matchAll(/^USER (.+)$/gm)) expect(user).toMatch(/^\d+:\d+$/);
  });
});

type Container = {
  name: string;
  env?: { name: string; value?: string; valueFrom?: { secretKeyRef?: { key: string } } }[];
  securityContext?: Record<string, unknown>;
  readinessProbe?: Probe;
  livenessProbe?: Probe;
};
type Probe = { httpGet?: { path: string }; tcpSocket?: unknown };
type PodSpec = {
  serviceAccountName?: string;
  automountServiceAccountToken?: boolean;
  terminationGracePeriodSeconds?: number;
  securityContext?: Record<string, unknown>;
  containers: Container[];
};
type Peer = { podSelector?: { matchLabels: Record<string, string> }; ipBlock?: unknown };
type Manifest = {
  kind: string;
  metadata: { name: string; annotations?: Record<string, string> };
  spec: {
    template?: { spec: PodSpec };
    podSelector?: { matchLabels: Record<string, string> };
    policyTypes?: string[];
    ingress?: { from?: Peer[]; ports?: unknown[] }[];
    egress?: { to?: Peer[]; ports?: unknown[] }[];
  };
};

const CHART_DIR = fileURLToPath(new URL('../../../deploy/helm/agile-copilot', import.meta.url));
const helmBin = process.env.HELM_BIN ?? 'helm';
const helmAvailable = (() => {
  try {
    execFileSync(helmBin, ['version', '--short'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
// The CI `helm` job sets HELM_REQUIRED=1: there these tests must run, never skip.
if (process.env.HELM_REQUIRED === '1' && !helmAvailable) {
  throw new Error(`HELM_REQUIRED=1 but ${helmBin} is not runnable`);
}

const render = (...set: string[]): Manifest[] => {
  const args = ['template', 'agile', CHART_DIR, '--set', 'secrets.existingSecret=agile-secrets'];
  for (const s of set) args.push('--set', s);
  const out = execFileSync(helmBin, args, { encoding: 'utf8' });
  return parseAllDocuments(out)
    .map((d) => d.toJS() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
};
const find = (ms: Manifest[], kind: string, name: string) => {
  const m = ms.find((x) => x.kind === kind && x.metadata.name === `agile-agile-copilot-${name}`);
  if (!m) throw new Error(`${kind} ${name} not rendered`);
  return m;
};
const pod = (ms: Manifest[], kind: string, name: string) => {
  const spec = find(ms, kind, name).spec.template?.spec;
  if (!spec) throw new Error(`${kind} ${name} has no pod template`);
  return spec;
};
const envNames = (c: Container | undefined) => (c?.env ?? []).map((e) => e.name);
const components = (peers: Peer[] | undefined) =>
  (peers ?? []).map((p) => p.podSelector?.matchLabels['app.kubernetes.io/component']);

/** Keys of a zod object schema in a source file: `  KEY: z…` lines at the given indentation. */
const schemaKeys = (file: string, indent: number) =>
  [...repoFile(file).matchAll(new RegExp(`^ {${indent}}([A-Z][A-Z0-9_]+):`, 'gm'))].map(
    (m) => m[1] ?? '',
  );

describe.skipIf(!helmAvailable)('Helm chart, rendered (helm template)', () => {
  // Rendered in beforeAll: a skipped suite is still collected, and helm may be missing.
  let ms: Manifest[] = [];
  beforeAll(() => {
    ms = render();
  });
  const deployments = ['web', 'worker', 'mcp-atlassian', 'mcp-atlassian-readonly'];

  it('refuses to render without secrets.existingSecret', () => {
    expect(() =>
      execFileSync(helmBin, ['template', 'agile', CHART_DIR], { stdio: 'pipe' }),
    ).toThrow(/secrets.existingSecret is required/);
  });

  it('gives the owner credentials to the pre-install/pre-upgrade migration Job only', () => {
    const job = find(ms, 'Job', 'migrate');
    expect(job.metadata.annotations?.['helm.sh/hook']).toBe('pre-install,pre-upgrade');
    expect(envNames(pod(ms, 'Job', 'migrate').containers[0])).toEqual(['DATABASE_OWNER_URL']);
    // A pre-install hook runs before the chart's ServiceAccount exists: it must not need it.
    expect(pod(ms, 'Job', 'migrate').serviceAccountName).toBeUndefined();
    for (const d of deployments) {
      for (const c of pod(ms, 'Deployment', d).containers)
        expect(envNames(c), d).not.toContain('DATABASE_OWNER_URL');
    }
    expect(ms.map((m) => m.kind)).not.toContain('Secret');
  });

  it('runs every pod as a numeric non-root user, without privileges or an API token', () => {
    const uid = (name: string) => (name.startsWith('mcp-atlassian') ? 1000 : 10001);
    const pods: [string, string][] = [
      ...deployments.map((d): [string, string] => ['Deployment', d]),
      ['Job', 'migrate'],
    ];
    for (const [kind, name] of pods) {
      const spec = pod(ms, kind, name);
      expect(spec.automountServiceAccountToken, name).toBe(false);
      expect(spec.securityContext, name).toMatchObject({
        runAsNonRoot: true,
        runAsUser: uid(name),
        runAsGroup: uid(name),
        seccompProfile: { type: 'RuntimeDefault' },
      });
      for (const c of spec.containers) {
        expect(c.securityContext, name).toMatchObject({
          allowPrivilegeEscalation: false,
          capabilities: { drop: ['ALL'] },
        });
      }
    }
  });

  it('lets the worker finish its stop backstop before Kubernetes kills it', () => {
    const backstop = /WORKER_STOP_BACKSTOP_MS = ([\d_]+);/.exec(
      repoFile('apps/worker/src/worker.ts'),
    );
    const backstopSeconds = Number(backstop?.[1]?.replaceAll('_', '')) / 1000;
    expect(backstopSeconds).toBeGreaterThan(0);
    expect(pod(ms, 'Deployment', 'worker').terminationGracePeriodSeconds).toBeGreaterThan(
      backstopSeconds,
    );
  });

  it('probes the web app without touching the identity provider', () => {
    // /login and /api/auth start SSO discovery (AuthHolder.ssoReady): an IdP outage must not
    // take every web pod out of the Service.
    const [web] = pod(ms, 'Deployment', 'web').containers;
    for (const probe of [web?.readinessProbe, web?.livenessProbe]) {
      expect(probe).toBeDefined();
      expect(probe?.httpGet?.path ?? '').not.toMatch(/^\/(login|signup|api\/auth)/);
    }
  });

  it('sets every server setting on web and worker, and nothing outside the env schemas', () => {
    const server = schemaKeys('packages/config/src/env.ts', 4);
    const workerExtras = schemaKeys('packages/config/src/worker-env.ts', 2);
    expect(server).toEqual(
      expect.arrayContaining(['DATABASE_URL', 'OIDC_ISSUER', 'PASSWORD_LOGIN']),
    );
    expect(workerExtras).toEqual([
      'SYNC_INTERVAL_MINUTES',
      'WORKER_HEALTH_PORT',
      'WORKER_HEALTH_HOST',
    ]);
    // Set by the image (NODE_ENV) or for development only (STRIPE_API_URL: stripe-mock).
    const expected = server.filter((k) => !['NODE_ENV', 'STRIPE_API_URL'].includes(k));
    const web = envNames(pod(ms, 'Deployment', 'web').containers[0]);
    const worker = envNames(pod(ms, 'Deployment', 'worker').containers[0]);
    expect([...web].sort()).toEqual(expected.sort());
    expect([...worker].sort()).toEqual(
      [...expected.filter((k) => k !== 'MCP_ATLASSIAN_URL'), ...workerExtras].sort(),
    );
  });

  it('runs mcp-atlassian with the allowlists and no operator Jira credentials', () => {
    const env = (name: string) =>
      Object.fromEntries(
        (pod(ms, 'Deployment', name).containers[0]?.env ?? []).map((e) => [e.name, e.value]),
      );
    const rw = env('mcp-atlassian');
    const ro = env('mcp-atlassian-readonly');
    expect(list(rw.ENABLED_TOOLS ?? '')).toEqual([...MCP_ATLASSIAN_ENABLED_TOOLS].sort());
    expect(list(ro.ENABLED_TOOLS ?? '')).toEqual([...MCP_ATLASSIAN_READONLY_ENABLED_TOOLS].sort());
    expect(rw.READ_ONLY_MODE).toBeUndefined();
    expect(ro.READ_ONLY_MODE).toBe('true');
    for (const e of [rw, ro]) {
      expect(Object.keys(e).join(',')).not.toMatch(
        /JIRA_URL|JIRA_USERNAME|JIRA_API_TOKEN|JIRA_PERSONAL_TOKEN|ALLOW_GLOBAL_CRED_FALLBACK/,
      );
      expect(e.ATLASSIAN_OAUTH_ENABLE).toBe('true');
    }
  });

  it('mirrors the compose networks: only web reaches mcp-atlassian, web and worker its twin', () => {
    const rw = find(ms, 'NetworkPolicy', 'mcp-atlassian').spec;
    const ro = find(ms, 'NetworkPolicy', 'mcp-atlassian-readonly').spec;
    expect(rw.ingress?.flatMap((r) => components(r.from))).toEqual(['web']);
    expect(ro.ingress?.flatMap((r) => components(r.from))).toEqual(['web', 'worker']);
    // Nothing connects to the worker.
    const worker = find(ms, 'NetworkPolicy', 'worker').spec;
    expect(worker.policyTypes).toEqual(['Ingress']);
    expect(worker.ingress).toEqual([]);
    // The worker's URL for the read-write instance does not exist.
    const workerEnv = pod(ms, 'Deployment', 'worker').containers[0]?.env ?? [];
    expect(workerEnv.map((e) => e.value ?? '').join(' ')).not.toMatch(/mcp-atlassian:8000/);
  });

  it('lets mcp-atlassian reach DNS and public addresses only, plus jiraPrivateCidrs', () => {
    const egress = (m: Manifest[]) => find(m, 'NetworkPolicy', 'mcp-atlassian-readonly').spec;
    const spec = egress(ms);
    expect(spec.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(spec.egress).toEqual([
      {
        ports: [
          { port: 53, protocol: 'UDP' },
          { port: 53, protocol: 'TCP' },
        ],
      },
      {
        to: [
          {
            ipBlock: {
              cidr: '0.0.0.0/0',
              except: [
                '10.0.0.0/8',
                '172.16.0.0/12',
                '192.168.0.0/16',
                '100.64.0.0/10',
                '169.254.0.0/16',
              ],
            },
          },
        ],
      },
    ]);
    const withJira = egress(render('networkPolicy.jiraPrivateCidrs[0]=10.20.0.0/16')).egress;
    expect(withJira?.at(-1)).toEqual({ to: [{ ipBlock: { cidr: '10.20.0.0/16' } }] });
  });

  it('drops the mcp-atlassian pods, their URLs and policies when disabled', () => {
    const off = render('mcpAtlassian.enabled=false');
    expect(off.filter((m) => m.metadata.name.includes('mcp-atlassian'))).toEqual([]);
    for (const d of ['web', 'worker']) {
      expect(envNames(pod(off, 'Deployment', d).containers[0]).join(',')).not.toMatch(
        /MCP_ATLASSIAN/,
      );
    }
  });
});
