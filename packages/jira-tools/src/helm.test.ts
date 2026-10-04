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
  image?: string;
  volumeMounts?: { name: string; mountPath: string }[];
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
  volumes?: { name: string; emptyDir?: Record<string, unknown> }[];
  containers: Container[];
};
type Peer = {
  podSelector?: { matchLabels: Record<string, string> };
  namespaceSelector?: { matchLabels: Record<string, string> };
  ipBlock?: { cidr: string; except?: string[] };
};
type Manifest = {
  kind: string;
  metadata: { name: string; annotations?: Record<string, string> };
  spec: {
    backoffLimit?: number;
    activeDeadlineSeconds?: number;
    template?: { metadata?: { labels?: Record<string, string> }; spec: PodSpec };
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
    expect(job.metadata.annotations).toMatchObject({
      'helm.sh/hook': 'pre-install,pre-upgrade',
      'helm.sh/hook-weight': '0',
      'helm.sh/hook-delete-policy': 'before-hook-creation,hook-succeeded',
    });
    // A failed migration is not retried blindly, and it fails before Helm's default 5-minute
    // --timeout gives up on the hook.
    expect(job.spec.backoffLimit).toBe(0);
    expect(job.spec.activeDeadlineSeconds).toBeLessThan(300);
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
          readOnlyRootFilesystem: true,
          capabilities: { drop: ['ALL'] },
        });
      }
    }
  });

  it('gives each read-only pod only the scratch directories it writes, as emptyDirs', () => {
    // Checked with `docker run --read-only --tmpfs …` on each image (see the Task 18 report).
    const writable: Record<string, string[]> = {
      web: ['/tmp', '/app/apps/web/.next/cache'],
      worker: ['/tmp'],
      migrate: ['/tmp', '/home/app'],
      'mcp-atlassian': ['/tmp', '/home/app'],
      'mcp-atlassian-readonly': ['/tmp', '/home/app'],
    };
    for (const [name, paths] of Object.entries(writable)) {
      const spec = pod(ms, name === 'migrate' ? 'Job' : 'Deployment', name);
      const [c] = spec.containers;
      const mounts = c?.volumeMounts ?? [];
      expect(mounts.map((m) => m.mountPath).sort(), name).toEqual([...paths].sort());
      for (const m of mounts) {
        const volume = spec.volumes?.find((v) => v.name === m.name);
        expect(volume?.emptyDir, `${name} ${m.mountPath}`).toBeDefined();
      }
    }
  });

  it('reads every secret from the existing Secret, by key, and never as a value', () => {
    const allowed = [
      'DATABASE_URL',
      'DATABASE_OWNER_URL',
      'BETTER_AUTH_SECRET',
      'ENCRYPTION_KEYS',
      'OIDC_CLIENT_SECRET',
      'ATLASSIAN_OAUTH_CLIENT_SECRET',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'LANGFUSE_PUBLIC_KEY',
      'LANGFUSE_SECRET_KEY',
    ];
    const pods: [string, string][] = [
      ...deployments.map((d): [string, string] => ['Deployment', d]),
      ['Job', 'migrate'],
    ];
    for (const [kind, name] of pods) {
      for (const e of pod(ms, kind, name).containers.flatMap((c) => c.env ?? [])) {
        if (allowed.includes(e.name)) {
          expect(e.value, `${name} ${e.name}`).toBeUndefined();
          expect(e.valueFrom?.secretKeyRef, `${name} ${e.name}`).toMatchObject({
            name: 'agile-secrets',
            key: e.name,
          });
        } else {
          expect(e.valueFrom, `${name} ${e.name}`).toBeUndefined();
        }
      }
    }
  });

  it('pins images by digest when one is given', () => {
    const pinned = render(`image.web.digest=sha256:${'a'.repeat(64)}`);
    expect(pod(pinned, 'Deployment', 'web').containers[0]?.image).toBe(
      `ghcr.io/example/agile-copilot-web:0.5.0@sha256:${'a'.repeat(64)}`,
    );
    expect(pod(ms, 'Deployment', 'web').containers[0]?.image).toBe(
      'ghcr.io/example/agile-copilot-web:0.5.0',
    );
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

  it('denies ingress to every pod of the release unless a policy allows it, migrate included', () => {
    const deny = find(ms, 'NetworkPolicy', 'default-deny').spec;
    expect(deny.policyTypes).toEqual(['Ingress']);
    expect(deny.ingress ?? []).toEqual([]);
    const selector = deny.podSelector?.matchLabels ?? {};
    expect(Object.keys(selector).length).toBeGreaterThan(0);
    const pods: [string, string][] = [
      ...deployments.map((d): [string, string] => ['Deployment', d]),
      ['Job', 'migrate'],
    ];
    for (const [kind, name] of pods) {
      const labels = find(ms, kind, name).spec.template?.metadata?.labels ?? {};
      expect(labels, name).toMatchObject(selector);
    }
  });

  const kubeDns = {
    namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
    podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
  };
  const dnsPorts = [
    { port: 53, protocol: 'UDP' },
    { port: 53, protocol: 'TCP' },
  ];
  const nonPublic = [
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.168.0.0/16',
    '198.18.0.0/15',
    '224.0.0.0/4',
    '240.0.0.0/4',
  ];

  it.each(['mcp-atlassian', 'mcp-atlassian-readonly'])(
    'lets %s reach cluster DNS and public IPv4 only, plus jiraPrivateCidrs',
    (name) => {
      const egress = (m: Manifest[]) => find(m, 'NetworkPolicy', name).spec;
      const spec = egress(ms);
      expect(spec.policyTypes).toEqual(['Ingress', 'Egress']);
      expect(spec.egress).toHaveLength(2);
      expect(spec.egress?.[0]).toEqual({ to: [kubeDns], ports: dnsPorts });
      const [publicRule] = spec.egress?.[1]?.to ?? [];
      expect(publicRule?.ipBlock?.cidr).toBe('0.0.0.0/0');
      expect([...(publicRule?.ipBlock?.except ?? [])].sort()).toEqual([...nonPublic].sort());
      // No IPv6 rule: IPv6 destinations are denied.
      expect(JSON.stringify(spec.egress)).not.toMatch(/::/);
      const withJira = egress(render('networkPolicy.jiraPrivateCidrs[0]=10.20.0.0/16')).egress;
      expect(withJira?.at(-1)).toEqual({ to: [{ ipBlock: { cidr: '10.20.0.0/16' } }] });
      // NodeLocal DNSCache: its link-local address is added to the DNS rule only.
      const nodeLocal = egress(render('networkPolicy.dns.cidrs[0]=169.254.20.10/32')).egress;
      expect(nodeLocal?.[0]).toEqual({
        to: [kubeDns, { ipBlock: { cidr: '169.254.20.10/32' } }],
        ports: dnsPorts,
      });
    },
  );

  it('warns in NOTES.txt when the web app is open to the whole cluster', () => {
    const notes = template('NOTES.txt');
    expect(notes).toMatch(/webIngressFrom/);
    expect(notes).toMatch(/ingress-nginx/);
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
