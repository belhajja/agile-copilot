# Docker Operator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An `operator` image whose CLI installs, upgrades (with backup and rollback), backs up,
restores, reconfigures and inspects the self-host stack through the host's Docker socket.

**Architecture:** A TypeScript CLI in `apps/operator`, bundled into one file with
`scripts/bundle-node.mjs`, shipped as a new `operator` stage of `apps/web/Dockerfile` (the slim
`runtime` base plus the Docker CLI and compose plugin). It keeps all state in `/data` and drives
`docker compose` with the repo's own compose files plus a generated override
(`compose.operator.yml`) that pins the image versions and injects the Postgres init script and
the Caddyfile as inline compose `configs` — so no host path is ever shared with the operator's
container.

**Tech Stack:** Node 24, TypeScript (ESM), Node built-ins only (`node:util` parseArgs,
`node:readline/promises`, `node:crypto`, `node:child_process`, `node:fs/promises`), Vitest,
Docker CLI 29 + Compose v5 (Alpine 3.24 packages `docker-cli`, `docker-cli-compose`).

**Spec:** `docs/superpowers/specs/2026-10-06-docker-operator-design.md`

## Global Constraints

- No new runtime dependencies: Node built-ins only. Dev tooling already in the repo (Vitest, esbuild via `scripts/bundle-node.mjs`, Biome).
- Every Docker call goes through `src/docker.ts` with an argument array (`spawn(..., { shell: false })`); no value ever reaches a shell.
- Secrets are generated with `crypto.randomBytes`, written only to `/data/.env` and backups with mode `0600`, never printed, logged or passed as a command-line argument (the registry token goes through stdin).
- Compose project name: `agile-copilot`. `/data` layout: `.env`, `compose/`, `backups/`, `operator.json`, `.operator.lock`.
- Image references: a release ref (`/^v?\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/`) → `<base>/<service>:<ref>`; any other ref → `<base>/<service>/snapshot:<ref slug>` (GitLab `CI_COMMIT_REF_SLUG` rules).
- Health wait: 5 minutes by default; backups kept: last 10; a lock older than 2 hours is stale.
- Exit codes: `0` success, `1` a step failed, `2` usage or validation error.
- Style: Biome (single quotes, 2 spaces, 100 columns); comments in the repo's matter-of-fact tone.
- Commits: one subject line, no body, no co-author trailer (the user's global rule).

## Review Focus

1. A setting containing `$`, a quote, `#`, a backslash or whitespace (a pasted host with a trailing space, an OIDC secret with `$`) → refused before anything is written; Compose would otherwise interpolate it from `.env`. Test: Task 1, "refuses values Compose would interpolate".
2. `upgrade` run with an operator older than the installed release → refused (migrations only go forward), nothing touched. Test: Task 7, "refuses a downgrade".
3. Two operator runs at once on the same `/data` → the second is refused; a lock left by a killed run (older than 2 hours) is taken over. Test: Task 3, "refuses a second run and takes over a stale lock".
4. `upgrade` on a stack that is not healthy (half-finished install, a crashed service) → refused before any backup or stop. Test: Task 7, "refuses to upgrade an unhealthy stack".
5. `install --resume` after a failed first start → keeps the generated secrets (the database volume was already initialised with them; new ones would lock the app out). Test: Task 5, "resume keeps the secrets of the first attempt".

---

### Task 1: Package scaffold and settings

**Files:**
- Create: `apps/operator/package.json`, `apps/operator/tsconfig.json`, `apps/operator/vitest.config.ts`
- Create: `apps/operator/src/settings.ts`
- Test: `apps/operator/src/settings.test.ts`
- Modify: `vitest.config.ts` (root: add the project), `apps/web/Dockerfile` (deps stage copies the new package.json), `pnpm-lock.yaml` (via `pnpm install`)

**Interfaces:**
- Produces: `type Mode = 'local' | 'server'`; `interface Settings { mode; port; domain; acmeEmail; jiraHosts; privateHosts; oidc; registry }`; `type RawSettings`; `SETTING_KEYS`; `class SettingsError { field }`; `parseHostList(field, raw): string[]`; `validateSettings(raw): Settings`; `publicUrl(s): string`; `PROMPTS`; `gatherSettings(raw, prompt, yes): Promise<RawSettings>`; `interface Prompter { ask(question, o?: { default?: string; secret?: boolean }): Promise<string>; confirm(question): Promise<boolean> }`.

- [ ] **Step 1: Scaffold the package**

`apps/operator/package.json`:
```json
{
  "name": "@agile/operator",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json"
  }
}
```

`apps/operator/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

`apps/operator/vitest.config.ts`:
```ts
import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'operator', environment: 'node', include: ['src/**/*.test.ts'] },
});
```

Root `vitest.config.ts`: `projects: ['packages/*', 'apps/web', 'apps/worker', 'apps/operator']`.

`apps/web/Dockerfile`, deps stage, after `COPY apps/worker/package.json apps/worker/`:
```dockerfile
COPY apps/operator/package.json apps/operator/
```

Run: `npx -y pnpm@10.14.0 install` (adds the importer to `pnpm-lock.yaml`).

- [ ] **Step 2: Write the failing tests**

`apps/operator/src/settings.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  gatherSettings,
  parseHostList,
  type Prompter,
  publicUrl,
  SettingsError,
  validateSettings,
} from './settings';

const refused = (raw: Parameters<typeof validateSettings>[0], field: string) => {
  try {
    validateSettings(raw);
  } catch (e) {
    expect(e).toBeInstanceOf(SettingsError);
    expect((e as SettingsError).field).toBe(field);
    return;
  }
  throw new Error(`expected ${field} to be refused`);
};

describe('settings', () => {
  it('defaults to a local install on port 3000', () => {
    const s = validateSettings({});
    expect(s).toMatchObject({ mode: 'local', port: 3000, domain: null, jiraHosts: [] });
    expect(publicUrl(s)).toBe('http://localhost:3000');
  });

  it('needs a domain and an e-mail on a server', () => {
    refused({ mode: 'server' }, 'domain');
    refused({ mode: 'server', domain: 'copilot.example.com' }, 'acme-email');
    const s = validateSettings({
      mode: 'server',
      domain: 'Copilot.Example.com',
      'acme-email': 'ops@example.com',
    });
    expect(publicUrl(s)).toBe('https://copilot.example.com');
  });

  it('refuses ports out of range and unknown modes', () => {
    refused({ port: '0' }, 'port');
    refused({ port: '70000' }, 'port');
    refused({ port: '30a' }, 'port');
    refused({ mode: 'cloud' }, 'mode');
  });

  it('parses host lists, lowercased, and refuses anything that is not a host', () => {
    expect(parseHostList('jira-hosts', ' Jira.Corp.local, portail.agir.orange.com ')).toEqual([
      'jira.corp.local',
      'portail.agir.orange.com',
    ]);
    expect(parseHostList('jira-hosts', '')).toEqual([]);
    expect(() => parseHostList('jira-hosts', 'https://jira.corp.local')).toThrow(SettingsError);
  });

  it('refuses values Compose would interpolate', () => {
    refused({ 'jira-hosts': 'jira.corp.local$x' }, 'jira-hosts');
    refused(
      {
        'oidc-issuer': 'https://sso.example.com/realms/agile',
        'oidc-client-id': 'agile',
        'oidc-client-secret': 'abc$def',
      },
      'oidc-client-secret',
    );
    refused({ 'registry-user': 'deploy token', 'registry-token': 'x' }, 'registry-user');
  });

  it('takes SSO and registry credentials all together or not at all', () => {
    refused({ 'oidc-issuer': 'https://sso.example.com/realms/agile' }, 'oidc-issuer');
    refused(
      {
        'oidc-issuer': 'http://sso.example.com',
        'oidc-client-id': 'a',
        'oidc-client-secret': 'b',
      },
      'oidc-issuer',
    );
    refused({ 'registry-user': 'gitlab+deploy-token-1' }, 'registry-user');
    expect(
      validateSettings({ 'registry-user': 'gitlab+deploy-token-1', 'registry-token': 'tok' })
        .registry,
    ).toEqual({ user: 'gitlab+deploy-token-1', token: 'tok' });
  });

  it('asks only for what the flags left out, and only what the mode needs', async () => {
    const asked: string[] = [];
    const prompt: Prompter = {
      ask: async (question, o) => {
        asked.push(question);
        return o?.default ?? '';
      },
      confirm: async () => true,
    };
    const raw = await gatherSettings({ mode: 'local', port: '3100' }, prompt, false);
    expect(raw).toMatchObject({ mode: 'local', port: '3100', 'jira-hosts': '' });
    expect(asked.some((q) => /Domain/.test(q))).toBe(false);
    expect(asked.some((q) => /Port/.test(q))).toBe(false);
  });

  it('asks nothing with --yes', async () => {
    const prompt: Prompter = {
      ask: async () => {
        throw new Error('asked');
      },
      confirm: async () => true,
    };
    expect(await gatherSettings({}, prompt, true)).toMatchObject({ mode: 'local', port: '3000' });
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run --project operator`
Expected: FAIL, `Cannot find module './settings'`.

- [ ] **Step 4: Implement `apps/operator/src/settings.ts`**

```ts
export type Mode = 'local' | 'server';

export interface Oidc {
  provider: 'keycloak' | 'oidc';
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export interface Registry {
  user: string;
  token: string;
}

export interface Settings {
  mode: Mode;
  port: number;
  domain: string | null;
  acmeEmail: string | null;
  jiraHosts: string[];
  privateHosts: string[];
  oidc: Oidc | null;
  registry: Registry | null;
}

export const SETTING_KEYS = [
  'mode',
  'port',
  'domain',
  'acme-email',
  'jira-hosts',
  'private-hosts',
  'oidc-provider',
  'oidc-issuer',
  'oidc-client-id',
  'oidc-client-secret',
  'registry-user',
  'registry-token',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** Answers from flags or prompts, by flag name. */
export type RawSettings = Partial<Record<SettingKey, string>>;

export class SettingsError extends Error {
  override name = 'SettingsError';
  constructor(
    readonly field: SettingKey,
    message: string,
  ) {
    super(`${field}: ${message}`);
  }
}

export interface Prompter {
  ask(question: string, o?: { default?: string; secret?: boolean }): Promise<string>;
  confirm(question: string): Promise<boolean>;
}

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Values go unquoted into .env, which Compose interpolates: none of these may appear.
const UNSAFE = /[\s$"'`#\\]/;

function clean(field: SettingKey, value: string | undefined): string {
  const v = (value ?? '').trim();
  if (UNSAFE.test(v)) {
    throw new SettingsError(field, 'must not contain spaces, quotes, $, # or backslashes');
  }
  return v;
}

export function parseHostList(field: SettingKey, raw: string | undefined): string[] {
  if (!(raw ?? '').trim()) return [];
  return (raw ?? '').split(',').map((part) => {
    const host = clean(field, part).toLowerCase();
    if (!HOSTNAME.test(host)) throw new SettingsError(field, `"${host}" is not a host name`);
    return host;
  });
}

function oidcOf(raw: RawSettings): Oidc | null {
  const issuer = clean('oidc-issuer', raw['oidc-issuer']);
  const clientId = clean('oidc-client-id', raw['oidc-client-id']);
  const clientSecret = clean('oidc-client-secret', raw['oidc-client-secret']);
  const given = [issuer, clientId, clientSecret].filter(Boolean).length;
  if (given === 0) return null;
  if (given < 3) {
    throw new SettingsError('oidc-issuer', 'set the issuer, client id and client secret together');
  }
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new SettingsError('oidc-issuer', 'must be a URL');
  }
  if (url.protocol !== 'https:') throw new SettingsError('oidc-issuer', 'must use https');
  const provider = clean('oidc-provider', raw['oidc-provider'] || 'keycloak');
  if (provider !== 'keycloak' && provider !== 'oidc') {
    throw new SettingsError('oidc-provider', 'must be keycloak or oidc');
  }
  return { provider, issuer, clientId, clientSecret };
}

function registryOf(raw: RawSettings): Registry | null {
  const user = clean('registry-user', raw['registry-user']);
  const token = clean('registry-token', raw['registry-token']);
  if (!user && !token) return null;
  if (!user || !token) {
    throw new SettingsError('registry-user', 'set the deploy token user and token together');
  }
  return { user, token };
}

export function validateSettings(raw: RawSettings): Settings {
  const mode = clean('mode', raw.mode || 'local');
  if (mode !== 'local' && mode !== 'server') {
    throw new SettingsError('mode', 'must be local or server');
  }
  const portText = clean('port', raw.port || '3000');
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    throw new SettingsError('port', 'must be a number from 1 to 65535');
  }
  let domain: string | null = null;
  let acmeEmail: string | null = null;
  if (mode === 'server') {
    domain = clean('domain', raw.domain).toLowerCase();
    if (!HOSTNAME.test(domain) || !domain.includes('.')) {
      throw new SettingsError('domain', 'must be a DNS name such as copilot.example.com');
    }
    acmeEmail = clean('acme-email', raw['acme-email']);
    if (!EMAIL.test(acmeEmail)) {
      throw new SettingsError('acme-email', "must be an e-mail address (Let's Encrypt account)");
    }
  }
  return {
    mode,
    port,
    domain,
    acmeEmail,
    jiraHosts: parseHostList('jira-hosts', raw['jira-hosts']),
    privateHosts: parseHostList('private-hosts', raw['private-hosts']),
    oidc: oidcOf(raw),
    registry: registryOf(raw),
  };
}

export function publicUrl(s: Settings): string {
  return s.mode === 'server' ? `https://${s.domain}` : `http://localhost:${s.port}`;
}

const isServer = (raw: RawSettings) => raw.mode === 'server';

/** What `install` asks for, in order. SSO is set with flags only (`--oidc-*`). */
export const PROMPTS: {
  key: SettingKey;
  question: string;
  default?: string;
  secret?: boolean;
  when?: (raw: RawSettings) => boolean;
}[] = [
  { key: 'mode', question: 'Mode: local (this computer) or server (HTTPS with a domain)', default: 'local' },
  { key: 'port', question: 'Port to publish the app on', default: '3000', when: (r) => !isServer(r) },
  { key: 'domain', question: 'Domain (its DNS points at this server)', when: isServer },
  { key: 'acme-email', question: "E-mail for Let's Encrypt", when: isServer },
  {
    key: 'jira-hosts',
    question: 'Jira Data Center hosts the assistant may reach (comma-separated, empty for none)',
    default: '',
  },
  {
    key: 'private-hosts',
    question: 'Hosts on a private network the app may reach (comma-separated, empty for none)',
    default: '',
  },
  {
    key: 'registry-user',
    question: 'Registry deploy token user (empty if this host is already logged in)',
    default: '',
  },
  {
    key: 'registry-token',
    question: 'Registry deploy token',
    secret: true,
    when: (r) => Boolean(r['registry-user']),
  },
];

/** Fills in what the flags left out: from prompts, or from the defaults with `--yes`. */
export async function gatherSettings(
  raw: RawSettings,
  prompt: Prompter,
  yes: boolean,
): Promise<RawSettings> {
  const answers: RawSettings = { ...raw };
  for (const p of PROMPTS) {
    if (answers[p.key] !== undefined || (p.when && !p.when(answers))) continue;
    answers[p.key] = yes
      ? (p.default ?? '')
      : await prompt.ask(p.question, { default: p.default, secret: p.secret });
  }
  return answers;
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run --project operator && (cd apps/operator && npx tsc --noEmit -p tsconfig.json)`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
npx biome check --write apps/operator vitest.config.ts
git add apps/operator vitest.config.ts apps/web/Dockerfile pnpm-lock.yaml
git commit -m "feat(operator): add the operator package and its install settings"
```

---

### Task 2: Secrets and the .env file

**Files:**
- Create: `apps/operator/src/secrets.ts`, `apps/operator/src/env-file.ts`
- Test: `apps/operator/src/secrets.test.ts`, `apps/operator/src/env-file.test.ts`

**Interfaces:**
- Consumes: `Settings`, `publicUrl` (Task 1).
- Produces: `interface Secrets { postgresPassword; appDbPassword; betterAuthSecret; encryptionKeys }`; `generateSecrets(random?): Secrets`; `parseEnv(text): Map<string, string>`; `renderEnv(values, previous?): string`; `ENV_SECRET_KEYS`; `secretValues(env: Map<string,string>): string[]`; `redact(text, secrets): string`; `envFor(settings, secrets, images: { web; worker; migrate }): Record<string, string>`.

- [ ] **Step 1: Write the failing tests**

`apps/operator/src/secrets.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { generateSecrets } from './secrets';

describe('generateSecrets', () => {
  it('makes URL-safe database passwords and 32-byte keys', () => {
    const s = generateSecrets();
    expect(s.postgresPassword).toMatch(/^[0-9a-f]{48}$/);
    expect(s.appDbPassword).toMatch(/^[0-9a-f]{48}$/);
    expect(Buffer.from(s.betterAuthSecret, 'base64')).toHaveLength(32);
    expect(s.encryptionKeys).toMatch(/^v1:[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(s.encryptionKeys.slice(3), 'base64')).toHaveLength(32);
  });

  it('never repeats a value', () => {
    const a = generateSecrets();
    const b = generateSecrets();
    expect(new Set([...Object.values(a), ...Object.values(b)]).size).toBe(8);
  });
});
```

`apps/operator/src/env-file.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { envFor, parseEnv, redact, renderEnv, secretValues } from './env-file';
import { generateSecrets } from './secrets';
import { validateSettings } from './settings';

const images = { web: 'r/web:v1', worker: 'r/worker:v1', migrate: 'r/migrate:v1' };

describe('.env', () => {
  it('replaces known keys in place and keeps comments and unknown keys', () => {
    const before = '# mine\nWEB_IMAGE=old\nCUSTOM=kept\r\n';
    const after = renderEnv({ WEB_IMAGE: 'new', WORKER_IMAGE: 'w' }, before);
    expect(after).toBe('# mine\nWEB_IMAGE=new\nCUSTOM=kept\nWORKER_IMAGE=w\n');
    expect(parseEnv(after).get('CUSTOM')).toBe('kept');
  });

  it('writes what the self-host compose files read, per mode', () => {
    const local = envFor(validateSettings({ port: '3100' }), generateSecrets(), images);
    expect(local).toMatchObject({
      COMPOSE_PROJECT_NAME: 'agile-copilot',
      BETTER_AUTH_URL: 'http://localhost:3100',
      WEB_PORT: '3100',
      WEB_IMAGE: 'r/web:v1',
    });
    expect(local.APP_DOMAIN).toBeUndefined();
    const server = envFor(
      validateSettings({ mode: 'server', domain: 'c.example.com', 'acme-email': 'o@example.com' }),
      generateSecrets(),
      images,
    );
    expect(server).toMatchObject({ APP_DOMAIN: 'c.example.com', ACME_EMAIL: 'o@example.com' });
  });

  it('redacts the secret values only, longest first', () => {
    const env = parseEnv('POSTGRES_PASSWORD=abcd1234\nWEB_PORT=3000\nENCRYPTION_KEYS=v1:abcd1234xyz\n');
    const text = 'pw abcd1234 key v1:abcd1234xyz port 3000';
    expect(redact(text, secretValues(env))).toBe('pw ••• key ••• port 3000');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project operator`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`apps/operator/src/secrets.ts`:
```ts
import { randomBytes } from 'node:crypto';

export interface Secrets {
  postgresPassword: string;
  appDbPassword: string;
  betterAuthSecret: string;
  encryptionKeys: string;
}

/** The stack's secrets. The database passwords are hex: the compose file uses them in URLs and SQL. */
export function generateSecrets(random: (n: number) => Buffer = randomBytes): Secrets {
  return {
    postgresPassword: random(24).toString('hex'),
    appDbPassword: random(24).toString('hex'),
    betterAuthSecret: random(32).toString('base64'),
    encryptionKeys: `v1:${random(32).toString('base64')}`,
  };
}
```

`apps/operator/src/env-file.ts`:
```ts
import type { Secrets } from './secrets';
import { publicUrl, type Settings } from './settings';

const LINE = /^([A-Z][A-Z0-9_]*)=(.*)$/;

export function parseEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line.trim());
    if (m?.[1] !== undefined) values.set(m[1], m[2] ?? '');
  }
  return values;
}

/** `previous` with `values` set: known keys replaced in place, new keys appended, the rest kept. */
export function renderEnv(values: Record<string, string>, previous = ''): string {
  const pending = new Map(Object.entries(values));
  const lines = previous ? previous.replace(/\r\n/g, '\n').split('\n') : [];
  if (lines.at(-1) === '') lines.pop();
  const out = lines.map((line) => {
    const key = LINE.exec(line)?.[1];
    if (key === undefined || !pending.has(key)) return line;
    const value = pending.get(key);
    pending.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of pending) out.push(`${key}=${value}`);
  return `${out.join('\n')}\n`;
}

export const ENV_SECRET_KEYS = [
  'POSTGRES_PASSWORD',
  'APP_DB_PASSWORD',
  'BETTER_AUTH_SECRET',
  'ENCRYPTION_KEYS',
  'OIDC_CLIENT_SECRET',
  'OPERATOR_REGISTRY_TOKEN',
] as const;

export function secretValues(env: Map<string, string>): string[] {
  return ENV_SECRET_KEYS.map((k) => env.get(k) ?? '').filter((v) => v.length >= 4);
}

export function redact(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    result = result.split(s).join('•••');
  }
  return result;
}

export function envFor(
  s: Settings,
  secrets: Secrets,
  images: { web: string; worker: string; migrate: string },
): Record<string, string> {
  const env: Record<string, string> = {
    COMPOSE_PROJECT_NAME: 'agile-copilot',
    DEPLOYMENT_MODE: 'selfhost',
    POSTGRES_PASSWORD: secrets.postgresPassword,
    APP_DB_PASSWORD: secrets.appDbPassword,
    BETTER_AUTH_SECRET: secrets.betterAuthSecret,
    ENCRYPTION_KEYS: secrets.encryptionKeys,
    BETTER_AUTH_URL: publicUrl(s),
    WEB_PORT: String(s.port),
    ALLOWED_PRIVATE_HOSTS: s.privateHosts.join(','),
    MCP_ALLOWED_URL_DOMAINS: s.jiraHosts.join(','),
    WEB_IMAGE: images.web,
    WORKER_IMAGE: images.worker,
    MIGRATE_IMAGE: images.migrate,
  };
  if (s.mode === 'server' && s.domain && s.acmeEmail) {
    env.APP_DOMAIN = s.domain;
    env.ACME_EMAIL = s.acmeEmail;
  }
  if (s.oidc) {
    env.OIDC_PROVIDER = s.oidc.provider;
    env.OIDC_ISSUER = s.oidc.issuer;
    env.OIDC_CLIENT_ID = s.oidc.clientId;
    env.OIDC_CLIENT_SECRET = s.oidc.clientSecret;
  }
  if (s.registry) {
    env.OPERATOR_REGISTRY_USER = s.registry.user;
    env.OPERATOR_REGISTRY_TOKEN = s.registry.token;
  }
  return env;
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run --project operator`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write apps/operator
git add apps/operator
git commit -m "feat(operator): generate the stack's secrets and write its .env"
```

---

### Task 3: Stack files, versions and the state folder

**Files:**
- Create: `apps/operator/src/stack.ts`, `apps/operator/src/state.ts`
- Test: `apps/operator/src/stack.test.ts`, `apps/operator/src/state.test.ts`

**Interfaces:**
- Consumes: `Mode` (Task 1).
- Produces (stack): `PROJECT = 'agile-copilot'`; `interface Build { ref; imageBase }`; `interface Images { web; worker; migrate }`; `isRelease(ref)`; `refSlug(ref)`; `imagesFor(build): Images`; `compareVersions(a, b): number`; `OVERRIDE_FILE`; `composeFiles(mode): string[]`; `escapeCompose(text)`; `renderOverride(mode, assets: { pgInit; caddyfile }): string`; `writeStack(dataDir, mode, assetsDir): Promise<void>`.
- Produces (state): `interface HistoryEntry { from; to; at; result: 'ok' | 'rolled_back' | 'rollback_failed' }`; `interface InstallState { version; mode; installedAt; history }`; `pathsOf(dataDir): { env; compose; backups; state; lock }`; `readState(dataDir)`; `writeState(dataDir, state)`; `writeSecretFile(path, content)`; `class LockedError`; `LOCK_STALE_MS`; `acquireLock(dataDir, now: Date): Promise<() => Promise<void>>`.

- [ ] **Step 1: Write the failing tests**

`apps/operator/src/stack.test.ts`:
```ts
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  composeFiles,
  imagesFor,
  isRelease,
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
      pgInit: '#!/bin/sh\r\necho "${APP_DB_PASSWORD}"\r\n',
      caddyfile: '{$APP_DOMAIN}',
    });
    expect(yaml).toContain('      echo "$${APP_DB_PASSWORD}"');
    expect(yaml).not.toContain('\r');
    expect(yaml).toContain('127.0.0.1:${WEB_PORT:-3000}:3000');
    expect(yaml).not.toContain('caddy');
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
```

`apps/operator/src/state.test.ts`:
```ts
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acquireLock,
  LOCK_STALE_MS,
  LockedError,
  pathsOf,
  readState,
  writeSecretFile,
  writeState,
} from './state';

const dir = () => mkdtemp(join(tmpdir(), 'operator-state-'));

describe('state folder', () => {
  it('reads nothing before an install, then what was written', async () => {
    const d = await dir();
    expect(await readState(d)).toBeNull();
    const state = { version: 'v1.0.0', mode: 'local' as const, installedAt: 'now', history: [] };
    await writeState(d, state);
    expect(await readState(d)).toEqual(state);
  });

  it('refuses a second run and takes over a stale lock', async () => {
    const d = await dir();
    const now = new Date('2026-10-06T12:00:00Z');
    const release = await acquireLock(d, now);
    await expect(acquireLock(d, now)).rejects.toBeInstanceOf(LockedError);
    await release();
    await acquireLock(d, now);
    // A lock a killed run left behind, older than LOCK_STALE_MS.
    const later = new Date(now.getTime() + LOCK_STALE_MS + 1);
    const again = await acquireLock(d, later);
    await again();
  });

  it('writes secret files readable by the owner only', async () => {
    const d = await dir();
    const path = pathsOf(d).env;
    await writeFile(path, 'old', { mode: 0o644 });
    await writeSecretFile(path, 'A=1\n');
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
```

Also create the shared test helpers now (used from this task on), `apps/operator/src/testing.ts`:
```ts
import { copyFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The files the operator image ships in /opt/operator/assets, copied from the repo. */
export async function repoAssets(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'operator-assets-'));
  await copyFile(join(REPO, 'docker-compose.selfhost.yml'), join(dir, 'docker-compose.selfhost.yml'));
  await copyFile(join(REPO, 'docker-compose.server.yml'), join(dir, 'docker-compose.server.yml'));
  await copyFile(join(REPO, 'docker/postgres/init/01-app-role.sh'), join(dir, 'postgres-init.sh'));
  await copyFile(join(REPO, 'docker/caddy/Caddyfile'), join(dir, 'Caddyfile'));
  return dir;
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project operator`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`apps/operator/src/stack.ts`:
```ts
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
    '    image: ${MIGRATE_IMAGE:?set MIGRATE_IMAGE}',
    '    build: !reset null',
    '  web:',
    '    image: ${WEB_IMAGE:?set WEB_IMAGE}',
    '    build: !reset null',
    ...(mode === 'local'
      ? ['    ports: !override', '      - 127.0.0.1:${WEB_PORT:-3000}:3000']
      : []),
    '  worker:',
    '    image: ${WORKER_IMAGE:?set WORKER_IMAGE}',
    '    build: !reset null',
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
```

`apps/operator/src/state.ts`:
```ts
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Mode } from './settings';

export interface HistoryEntry {
  from: string;
  to: string;
  at: string;
  result: 'ok' | 'rolled_back' | 'rollback_failed';
}

export interface InstallState {
  version: string;
  mode: Mode;
  installedAt: string;
  history: HistoryEntry[];
}

export function pathsOf(dataDir: string) {
  return {
    env: join(dataDir, '.env'),
    compose: join(dataDir, 'compose'),
    backups: join(dataDir, 'backups'),
    state: join(dataDir, 'operator.json'),
    lock: join(dataDir, '.operator.lock'),
  };
}

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

export async function readState(dataDir: string): Promise<InstallState | null> {
  try {
    return JSON.parse(await readFile(pathsOf(dataDir).state, 'utf8')) as InstallState;
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

/** Written to a temporary file and renamed: a crash never leaves half a state file. */
export async function writeState(dataDir: string, state: InstallState): Promise<void> {
  const path = pathsOf(dataDir).state;
  await writeFile(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

/** For .env and backups: owner-only, also when the file already existed with other rights. */
export async function writeSecretFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

export class LockedError extends Error {
  override name = 'LockedError';
  constructor() {
    super('Another operator command is running on this folder. Try again when it is done.');
  }
}

/** A lock older than this was left by a run that was killed. */
export const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

export async function acquireLock(dataDir: string, now: Date): Promise<() => Promise<void>> {
  await mkdir(dataDir, { recursive: true });
  const path = pathsOf(dataDir).lock;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, 'wx');
      await file.writeFile(JSON.stringify({ at: now.toISOString() }));
      await file.close();
      return () => rm(path, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const held = JSON.parse(await readFile(path, 'utf8').catch(() => '{}')) as { at?: string };
      const age = now.getTime() - Date.parse(held.at ?? '');
      if (!(age > LOCK_STALE_MS)) throw new LockedError();
      await rm(path, { force: true });
    }
  }
  throw new LockedError();
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run --project operator`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write apps/operator
git add apps/operator
git commit -m "feat(operator): render the compose override and keep the install state"
```

---

### Task 4: Docker runner, health and test fakes

**Files:**
- Create: `apps/operator/src/errors.ts`, `apps/operator/src/docker.ts`, `apps/operator/src/context.ts`
- Modify: `apps/operator/src/testing.ts` (add the fakes)
- Test: `apps/operator/src/docker.test.ts`

**Interfaces:**
- Consumes: `PROJECT`, `composeFiles`, `Build` (Task 3); `pathsOf` (Task 3); `Mode`, `Prompter` (Task 1).
- Produces: `class UsageError`, `class StepError { step; detail }` (errors.ts); `interface RunResult { code; stdout; stderr }`; `interface RunOptions { stdin?; stdinFile?; stdoutFile?; onStdout?(chunk) }`; `interface Docker { run(args, opts?) }`; `realDocker`; `class Compose { run(rest, opts?); check(step, rest, opts?) }`; `interface ServiceState`; `parsePs(stdout)`; `stackHealth(states, services)`; `servicesOf(mode)`; `waitHealthy(ctx, compose, mode)`; `registryLogin(ctx, env)`; `interface Context` (context.ts); testing: `commandOf(args)`, `FakeDocker`, `psLines(states)`, `healthyPs(mode)`, `tempContext(o)`.

- [ ] **Step 1: Write the failing tests**

`apps/operator/src/docker.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Compose, parsePs, registryLogin, stackHealth, servicesOf, waitHealthy } from './docker';
import { StepError } from './errors';
import { psLines, tempContext } from './testing';

describe('compose ps and health', () => {
  it('reads both the line-per-service and the array formats', () => {
    const line = psLines({ web: { state: 'running', health: 'healthy' } });
    expect(parsePs(line)).toEqual([{ service: 'web', state: 'running', health: 'healthy', exitCode: 0 }]);
    expect(parsePs(`[${line}]`)).toHaveLength(1);
    expect(parsePs('')).toEqual([]);
  });

  it('is ready when migrate exited 0 and the rest run healthy (caddy has no healthcheck)', () => {
    const services = servicesOf('server');
    const states = parsePs(
      psLines({
        postgres: { state: 'running', health: 'healthy' },
        migrate: { state: 'exited', exitCode: 0 },
        web: { state: 'running', health: 'healthy' },
        worker: { state: 'running', health: 'healthy' },
        'mcp-atlassian': { state: 'running', health: 'healthy' },
        'mcp-atlassian-readonly': { state: 'running', health: 'healthy' },
        caddy: { state: 'running' },
      }),
    );
    expect(stackHealth(states, services)).toEqual({ ready: true, failed: null });
  });

  it('names the service that failed: migrate exiting non-zero, an unhealthy service', () => {
    const services = servicesOf('local');
    expect(
      stackHealth(parsePs(psLines({ migrate: { state: 'exited', exitCode: 1 } })), services),
    ).toEqual({ ready: false, failed: 'migrate' });
    expect(
      stackHealth(parsePs(psLines({ web: { state: 'running', health: 'unhealthy' } })), services),
    ).toEqual({ ready: false, failed: 'web' });
    expect(
      stackHealth(parsePs(psLines({ web: { state: 'running', health: 'starting' } })), services),
    ).toEqual({ ready: false, failed: null });
  });

  it('waits until healthy, and gives up after the timeout', async () => {
    let calls = 0;
    const { ctx } = await tempContext({
      respond: (cmd) => {
        if (!cmd.startsWith('compose ps')) return undefined;
        calls++;
        return calls < 3 ? { stdout: psLines({ web: { state: 'running', health: 'starting' } }) } : undefined;
      },
    });
    await waitHealthy(ctx, new Compose(ctx.docker, ctx.dataDir, 'local'), 'local');
    expect(calls).toBe(3);

    const slow = await tempContext({
      respond: (cmd) =>
        cmd.startsWith('compose ps') ? { stdout: psLines({ web: { state: 'created' } }) } : undefined,
    });
    await expect(
      waitHealthy(slow.ctx, new Compose(slow.ctx.docker, slow.ctx.dataDir, 'local'), 'local'),
    ).rejects.toThrow(StepError);
  });
});

describe('Compose', () => {
  it('always names the project, the folder, the .env and every compose file', async () => {
    const { ctx, docker } = await tempContext();
    await new Compose(ctx.docker, ctx.dataDir, 'server').run(['up', '-d']);
    const args = docker.calls[0]?.args ?? [];
    expect(args.slice(0, 3)).toEqual(['compose', '--project-name', 'agile-copilot']);
    expect(args.filter((a) => a === '-f')).toHaveLength(3);
    expect(args.slice(-2)).toEqual(['up', '-d']);
  });

  it('turns a failed command into a StepError naming the step', async () => {
    const { ctx } = await tempContext({ respond: () => ({ code: 1, stderr: 'boom' }) });
    await expect(
      new Compose(ctx.docker, ctx.dataDir, 'local').check('pull', ['pull']),
    ).rejects.toMatchObject({ step: 'pull', detail: 'boom' });
  });
});

describe('registryLogin', () => {
  it('sends the token on stdin, never as an argument', async () => {
    const { ctx, docker } = await tempContext();
    const env = new Map([
      ['OPERATOR_REGISTRY_USER', 'gitlab+deploy-token-1'],
      ['OPERATOR_REGISTRY_TOKEN', 'secret-token'],
    ]);
    await registryLogin(ctx, env);
    const call = docker.calls[0];
    expect(call?.args).toEqual([
      'login',
      'registry.example.com',
      '--username',
      'gitlab+deploy-token-1',
      '--password-stdin',
    ]);
    expect(call?.opts?.stdin).toBe('secret-token');
  });

  it('does nothing without credentials', async () => {
    const { ctx, docker } = await tempContext();
    await registryLogin(ctx, new Map());
    expect(docker.calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project operator`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`apps/operator/src/errors.ts`:
```ts
/** The command was used wrongly or refused: exit code 2, the message says what to do. */
export class UsageError extends Error {
  override name = 'UsageError';
}

/** A step of a command failed: exit code 1. `detail` may hold Docker output (redact it). */
export class StepError extends Error {
  override name = 'StepError';
  constructor(
    readonly step: string,
    readonly detail: string,
  ) {
    super(`${step} failed`);
  }
}
```

`apps/operator/src/context.ts`:
```ts
import type { Docker } from './docker';
import type { Prompter } from './settings';
import type { Build } from './stack';

export interface Context {
  dataDir: string;
  /** The compose files and the files they mount, shipped in the image. */
  assetsDir: string;
  build: Build;
  docker: Docker;
  out: (line: string) => void;
  prompt: Prompter;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  healthTimeoutMs: number;
}
```

`apps/operator/src/docker.ts`:
```ts
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

/** The host's Docker through the CLI. Arguments as an array: nothing goes through a shell. */
export const realDocker: Docker = {
  run(args, opts = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn('docker', args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const file = opts.stdoutFile ? createWriteStream(opts.stdoutFile, { mode: 0o600 }) : null;
      const written = file ? new Promise((r) => file.on('close', r)) : Promise.resolve();
      if (file) child.stdout.pipe(file);
      else child.stdout.on('data', (d: Buffer) => {
        if (opts.onStdout) opts.onStdout(d.toString());
        else stdout += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      if (opts.stdinFile) createReadStream(opts.stdinFile).pipe(child.stdin);
      else child.stdin.end(opts.stdin ?? '');
      child.on('error', reject);
      child.on('close', async (code) => {
        await written;
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  },
};

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
    text.startsWith('[') ? JSON.parse(text) : text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
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
```

Append to `apps/operator/src/testing.ts`:
```ts
import { writeFile } from 'node:fs/promises';
import type { Context } from './context';
import { type Docker, type RunOptions, type RunResult, servicesOf } from './docker';
import type { Mode } from './settings';

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
      JSON.stringify({ Service, State: s.state, Health: s.health ?? '', ExitCode: s.exitCode ?? 0 }),
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
      this.respond(cmd, args, opts) ?? (cmd.startsWith('compose ps') ? { stdout: healthyPs(this.mode) } : {});
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
```
(Merge the imports with the ones Task 3 put at the top of the file.)

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run --project operator && (cd apps/operator && npx tsc --noEmit -p tsconfig.json)`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write apps/operator
git add apps/operator
git commit -m "feat(operator): drive docker compose and wait for a healthy stack"
```

---

### Task 5: `install`

**Files:**
- Create: `apps/operator/src/commands/install.ts`
- Test: `apps/operator/src/commands/install.test.ts`

**Interfaces:**
- Consumes: `gatherSettings`, `validateSettings`, `RawSettings` (Task 1); `generateSecrets`, `envFor`, `renderEnv`, `parseEnv` (Task 2); `imagesFor`, `writeStack` (Task 3); `acquireLock`, `pathsOf`, `readState`, `writeState`, `writeSecretFile` (Task 3); `Compose`, `registryLogin`, `waitHealthy` (Task 4); `UsageError` (Task 4); `Context`.
- Produces: `install(ctx, raw: RawSettings, o: { yes: boolean; resume: boolean }): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

`apps/operator/src/commands/install.test.ts`:
```ts
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../env-file';
import { UsageError } from '../errors';
import { readState } from '../state';
import { tempContext } from '../testing';
import { install } from './install';

describe('install', () => {
  it('writes the stack, starts it and waits for health', async () => {
    const { ctx, docker, out, dataDir } = await tempContext();
    await install(ctx, { port: '3100', 'jira-hosts': 'jira.corp.local' }, { yes: true, resume: false });
    expect(docker.commands).toEqual(['compose pull', 'compose up -d', 'compose ps -a --format json']);
    const env = parseEnv(await readFile(join(dataDir, '.env'), 'utf8'));
    expect(env.get('WEB_IMAGE')).toBe('registry.example.com/agile/web:v1.0.0');
    expect(env.get('MCP_ALLOWED_URL_DOMAINS')).toBe('jira.corp.local');
    expect(env.get('BETTER_AUTH_URL')).toBe('http://localhost:3100');
    if (process.platform !== 'win32') {
      expect((await stat(join(dataDir, '.env'))).mode & 0o777).toBe(0o600);
    }
    expect(await readState(dataDir)).toMatchObject({ version: 'v1.0.0', mode: 'local' });
    expect(out.at(-2)).toMatch(/http:\/\/localhost:3100/);
    // No secret in the output.
    const secret = env.get('POSTGRES_PASSWORD') ?? '';
    expect(out.join('\n')).not.toContain(secret);
  });

  it('logs in first when a deploy token is given', async () => {
    const { ctx, docker } = await tempContext();
    await install(
      ctx,
      { 'registry-user': 'gitlab+deploy-token-1', 'registry-token': 'tok' },
      { yes: true, resume: false },
    );
    expect(docker.commands[0]).toMatch(/^login registry\.example\.com/);
  });

  it('refuses a folder that already has an install', async () => {
    const { ctx } = await tempContext();
    await install(ctx, {}, { yes: true, resume: false });
    await expect(install(ctx, {}, { yes: true, resume: false })).rejects.toBeInstanceOf(UsageError);
  });

  it('writes nothing when a setting is refused', async () => {
    const { ctx, dataDir } = await tempContext();
    await expect(install(ctx, { port: '99999' }, { yes: true, resume: false })).rejects.toThrow();
    expect(await readState(dataDir)).toBeNull();
  });

  it('stops what it started when the stack does not come up', async () => {
    const { ctx, docker } = await tempContext({
      respond: (cmd) => (cmd === 'compose up -d' ? { code: 1, stderr: 'port is already allocated' } : undefined),
    });
    await expect(install(ctx, {}, { yes: true, resume: false })).rejects.toMatchObject({ step: 'start' });
    expect(docker.commands.at(-1)).toBe('compose stop');
  });

  it('resume keeps the secrets of the first attempt', async () => {
    let fail = true;
    const { ctx, dataDir } = await tempContext({
      respond: (cmd) => (cmd === 'compose up -d' && fail ? { code: 1, stderr: 'x' } : undefined),
    });
    await expect(install(ctx, {}, { yes: true, resume: false })).rejects.toThrow();
    const first = parseEnv(await readFile(join(dataDir, '.env'), 'utf8')).get('POSTGRES_PASSWORD');
    fail = false;
    await install(ctx, {}, { yes: true, resume: true });
    const second = parseEnv(await readFile(join(dataDir, '.env'), 'utf8')).get('POSTGRES_PASSWORD');
    expect(second).toBe(first);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project operator`
Expected: FAIL, `./install` not found.

- [ ] **Step 3: Implement `apps/operator/src/commands/install.ts`**

```ts
import { readFile } from 'node:fs/promises';
import type { Context } from '../context';
import { Compose, registryLogin, waitHealthy } from '../docker';
import { envFor, parseEnv, renderEnv } from '../env-file';
import { UsageError } from '../errors';
import { generateSecrets } from '../secrets';
import { gatherSettings, type RawSettings, validateSettings } from '../settings';
import { imagesFor, writeStack } from '../stack';
import { acquireLock, pathsOf, readState, writeSecretFile, writeState } from '../state';

export async function install(
  ctx: Context,
  raw: RawSettings,
  o: { yes: boolean; resume: boolean },
): Promise<void> {
  const release = await acquireLock(ctx.dataDir, ctx.now());
  try {
    const p = pathsOf(ctx.dataDir);
    const existing = await readState(ctx.dataDir);
    if (existing && !o.resume) {
      throw new UsageError('This folder already has an install: use `upgrade` or `config`.');
    }
    if (!existing && o.resume) throw new UsageError('Nothing to resume here: run `install`.');

    let mode = existing?.mode ?? 'local';
    if (!existing) {
      // Everything is validated before the first file is written.
      const settings = validateSettings(await gatherSettings(raw, ctx.prompt, o.yes));
      mode = settings.mode;
      await writeStack(ctx.dataDir, mode, ctx.assetsDir);
      await writeSecretFile(p.env, renderEnv(envFor(settings, generateSecrets(), imagesFor(ctx.build))));
      await writeState(ctx.dataDir, {
        version: ctx.build.ref,
        mode,
        installedAt: ctx.now().toISOString(),
        history: [],
      });
      ctx.out('✓ settings and secrets written');
    }

    const env = parseEnv(await readFile(p.env, 'utf8'));
    const compose = new Compose(ctx.docker, ctx.dataDir, mode);
    try {
      await registryLogin(ctx, env);
      await compose.check('pull', ['pull']);
      ctx.out('✓ images pulled');
      await compose.check('start', ['up', '-d']);
      await waitHealthy(ctx, compose, mode);
    } catch (e) {
      await compose.run(['stop']);
      ctx.out('Fix the cause, then run `install --resume` (the settings and secrets are kept).');
      throw e;
    }
    ctx.out(`✓ healthy: ${env.get('BETTER_AUTH_URL')}`);
    ctx.out('Next: create the first account, then add an AI model and Jira in Settings.');
  } finally {
    await release();
  }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run --project operator`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write apps/operator
git add apps/operator
git commit -m "feat(operator): install the stack from settings and generated secrets"
```

---

### Task 6: `backup` and `restore`

**Files:**
- Create: `apps/operator/src/commands/backup.ts`
- Test: `apps/operator/src/commands/backup.test.ts`

**Interfaces:**
- Consumes: `Compose`, `waitHealthy` (Task 4); `pathsOf`, `readState`, `writeState`, `acquireLock`, `InstallState` (Task 3); `UsageError` (Task 4); `install` (Task 5, tests only).
- Produces: `KEEP_BACKUPS = 10`; `listBackups(backupsDir): Promise<string[]>`; `takeBackup(ctx, state, compose): Promise<string>` (the backup folder); `restoreDatabase(compose, dumpFile): Promise<void>`; `backupCommand(ctx): Promise<void>`; `restoreCommand(ctx, name: string, o: { yes: boolean }): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

`apps/operator/src/commands/backup.test.ts`:
```ts
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageError } from '../errors';
import { readState } from '../state';
import { tempContext } from '../testing';
import { backupCommand, KEEP_BACKUPS, listBackups, restoreCommand } from './backup';
import { install } from './install';

const installed = async (o: Parameters<typeof tempContext>[0] = {}) => {
  const t = await tempContext(o);
  await install(t.ctx, {}, { yes: true, resume: false });
  t.docker.calls.length = 0;
  return t;
};

describe('backup', () => {
  it('dumps the database and keeps .env and the compose files with it', async () => {
    const { ctx, docker, dataDir } = await installed();
    await backupCommand(ctx);
    expect(docker.commands).toEqual(['compose exec -T postgres pg_dump -U agile -d agile -Fc']);
    const [name] = await listBackups(join(dataDir, 'backups'));
    const files = await readdir(join(dataDir, 'backups', name ?? ''));
    expect(files.sort()).toEqual(['.env', 'compose', 'db.dump', 'version']);
    expect(await readFile(join(dataDir, 'backups', name ?? '', 'version'), 'utf8')).toBe('v1.0.0');
  });

  it(`keeps the last ${KEEP_BACKUPS}`, async () => {
    const { ctx, dataDir } = await installed();
    for (let i = 0; i < KEEP_BACKUPS + 2; i++) {
      await backupCommand(ctx);
      await ctx.sleep(1000);
    }
    expect(await listBackups(join(dataDir, 'backups'))).toHaveLength(KEEP_BACKUPS);
  });
});

describe('restore', () => {
  it('asks first and does nothing when the answer is no', async () => {
    const { ctx, docker } = await installed({ confirm: false });
    await backupCommand(ctx);
    docker.calls.length = 0;
    await restoreCommand(ctx, 'latest', { yes: false });
    expect(docker.commands).toEqual([]);
  });

  it('stops the app, recreates the database from the dump and starts again', async () => {
    const { ctx, docker } = await installed();
    await backupCommand(ctx);
    docker.calls.length = 0;
    await restoreCommand(ctx, 'latest', { yes: true });
    expect(docker.commands[0]).toBe('compose stop web worker');
    expect(docker.commands[1]).toMatch(/psql .*DROP DATABASE IF EXISTS agile WITH \(FORCE\)/);
    expect(docker.commands[2]).toBe(
      'compose exec -T postgres pg_restore -U agile -d agile --exit-on-error',
    );
    expect(docker.calls[2]?.opts?.stdinFile).toMatch(/db\.dump$/);
    expect(docker.commands).toContain('compose up -d');
  });

  it('only restores backups that exist in the backups folder', async () => {
    const { ctx } = await installed();
    await expect(restoreCommand(ctx, '../../etc', { yes: true })).rejects.toBeInstanceOf(UsageError);
    await expect(restoreCommand(ctx, 'latest', { yes: true })).rejects.toBeInstanceOf(UsageError);
  });

  it('puts back the version of the backup', async () => {
    const { ctx, dataDir } = await installed();
    await backupCommand(ctx);
    const state = await readState(dataDir);
    if (state) {
      state.version = 'v9.9.9';
      await (await import('../state')).writeState(dataDir, state);
    }
    await restoreCommand(ctx, 'latest', { yes: true });
    expect((await readState(dataDir))?.version).toBe('v1.0.0');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project operator`
Expected: FAIL, `./backup` not found.

- [ ] **Step 3: Implement `apps/operator/src/commands/backup.ts`**

```ts
import { chmod, copyFile, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Context } from '../context';
import { Compose, waitHealthy } from '../docker';
import { UsageError } from '../errors';
import { acquireLock, type InstallState, pathsOf, readState, writeState } from '../state';

export const KEEP_BACKUPS = 10;

/** Backup folder names, oldest first (they start with an ISO timestamp). */
export async function listBackups(backupsDir: string): Promise<string[]> {
  try {
    return (await readdir(backupsDir)).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * The database (pg_dump custom format) with the .env and compose files of the same moment: the
 * .env holds ENCRYPTION_KEYS, without which the stored Jira and AI credentials cannot be read.
 */
export async function takeBackup(
  ctx: Context,
  state: InstallState,
  compose: Compose,
): Promise<string> {
  const p = pathsOf(ctx.dataDir);
  const stamp = ctx.now().toISOString().replace(/[:.]/g, '-');
  const dir = join(p.backups, `${stamp}-${state.version.replace(/[^\w.-]/g, '_')}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await compose.check('backup', ['exec', '-T', 'postgres', 'pg_dump', '-U', 'agile', '-d', 'agile', '-Fc'], {
    stdoutFile: join(dir, 'db.dump'),
  });
  await copyFile(p.env, join(dir, '.env'));
  await chmod(join(dir, '.env'), 0o600);
  await cp(p.compose, join(dir, 'compose'), { recursive: true });
  await writeFile(join(dir, 'version'), state.version);
  for (const old of (await listBackups(p.backups)).slice(0, -KEEP_BACKUPS)) {
    await rm(join(p.backups, old), { recursive: true, force: true });
  }
  return dir;
}

/** Replaces the database with a dump: a fresh database, the grants the init script made, the data. */
export async function restoreDatabase(compose: Compose, dumpFile: string): Promise<void> {
  const psql = ['exec', '-T', 'postgres', 'psql', '-U', 'agile', '-v', 'ON_ERROR_STOP=1'];
  await compose.check('restore', [
    ...psql,
    '-d',
    'postgres',
    '-c',
    'DROP DATABASE IF EXISTS agile WITH (FORCE)',
    '-c',
    'CREATE DATABASE agile OWNER agile',
    '-c',
    'GRANT CONNECT ON DATABASE agile TO app_user',
  ]);
  await compose.check(
    'restore',
    ['exec', '-T', 'postgres', 'pg_restore', '-U', 'agile', '-d', 'agile', '--exit-on-error'],
    { stdinFile: dumpFile },
  );
  await compose.check('restore', [...psql, '-d', 'agile', '-c', 'GRANT USAGE ON SCHEMA public TO app_user']);
}

async function installedState(ctx: Context): Promise<InstallState> {
  const state = await readState(ctx.dataDir);
  if (!state) throw new UsageError('No install in this folder: run `install`.');
  return state;
}

export async function backupCommand(ctx: Context): Promise<void> {
  const release = await acquireLock(ctx.dataDir, ctx.now());
  try {
    const state = await installedState(ctx);
    const dir = await takeBackup(ctx, state, new Compose(ctx.docker, ctx.dataDir, state.mode));
    ctx.out(`✓ backup ${basename(dir)}`);
  } finally {
    await release();
  }
}

/** `name` is a folder in backups/ (as `status` shows it) or `latest`. */
export async function restoreCommand(ctx: Context, name: string, o: { yes: boolean }): Promise<void> {
  const release = await acquireLock(ctx.dataDir, ctx.now());
  try {
    const state = await installedState(ctx);
    const p = pathsOf(ctx.dataDir);
    const chosen = name === 'latest' ? (await listBackups(p.backups)).at(-1) : basename(name);
    const dir = chosen && chosen === basename(chosen) ? join(p.backups, chosen) : null;
    if (!dir || !(await stat(join(dir, 'db.dump')).catch(() => null))) {
      throw new UsageError(`No backup "${name}" in ${p.backups}.`);
    }
    if (!o.yes && !(await ctx.prompt.confirm(`Replace the database with backup ${chosen}? Changes made since then are lost.`))) {
      ctx.out('Cancelled.');
      return;
    }
    const compose = new Compose(ctx.docker, ctx.dataDir, state.mode);
    await compose.check('stop', ['stop', 'web', 'worker']);
    await restoreDatabase(compose, join(dir, 'db.dump'));
    await copyFile(join(dir, '.env'), p.env);
    await chmod(p.env, 0o600);
    await cp(join(dir, 'compose'), p.compose, { recursive: true, force: true });
    const version = (await readFile(join(dir, 'version'), 'utf8')).trim();
    await writeState(ctx.dataDir, { ...state, version });
    await compose.check('start', ['up', '-d']);
    await waitHealthy(ctx, compose, state.mode);
    ctx.out(`✓ restored ${chosen} (${version})`);
  } finally {
    await release();
  }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run --project operator`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write apps/operator
git add apps/operator
git commit -m "feat(operator): back up and restore the database with its settings"
```

---

### Task 7: `upgrade` with rollback

**Files:**
- Create: `apps/operator/src/commands/upgrade.ts`
- Test: `apps/operator/src/commands/upgrade.test.ts`

**Interfaces:**
- Consumes: `takeBackup`, `restoreDatabase` (Task 6); `Compose`, `parsePs`, `stackHealth`, `servicesOf`, `registryLogin`, `waitHealthy` (Task 4); `imagesFor`, `isRelease`, `compareVersions`, `writeStack` (Task 3); `parseEnv`, `renderEnv` (Task 2); state helpers (Task 3); `StepError`, `UsageError`.
- Produces: `upgrade(ctx): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

`apps/operator/src/commands/upgrade.test.ts`:
```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../env-file';
import { StepError, UsageError } from '../errors';
import { readState } from '../state';
import { psLines, type Responder, tempContext } from '../testing';
import { install } from './install';
import { upgrade } from './upgrade';

/** An install of v1.0.0, then a context for an operator of `ref` on the same folder. */
async function from100(ref: string, respond?: Responder) {
  const first = await tempContext();
  await install(first.ctx, {}, { yes: true, resume: false });
  const next = await tempContext({ ref, respond });
  next.ctx.dataDir = first.dataDir;
  return { ...next, dataDir: first.dataDir };
}

const envOf = async (dataDir: string) => parseEnv(await readFile(join(dataDir, '.env'), 'utf8'));

describe('upgrade', () => {
  it('pulls, stops the app, backs up, switches images and waits for health', async () => {
    const { ctx, docker, dataDir } = await from100('v1.1.0');
    await upgrade(ctx);
    expect(docker.commands).toEqual([
      'compose ps -a --format json',
      'pull registry.example.com/agile/migrate:v1.1.0',
      'pull registry.example.com/agile/web:v1.1.0',
      'pull registry.example.com/agile/worker:v1.1.0',
      'compose stop web worker',
      'compose exec -T postgres pg_dump -U agile -d agile -Fc',
      'compose up -d',
      'compose ps -a --format json',
    ]);
    expect((await envOf(dataDir)).get('WEB_IMAGE')).toBe('registry.example.com/agile/web:v1.1.0');
    const state = await readState(dataDir);
    expect(state?.version).toBe('v1.1.0');
    expect(state?.history.at(-1)).toMatchObject({ from: 'v1.0.0', to: 'v1.1.0', result: 'ok' });
  });

  it('changes nothing when a pull fails', async () => {
    const { ctx, docker, dataDir } = await from100('v1.1.0', (cmd) =>
      cmd.startsWith('pull') ? { code: 1, stderr: 'not found' } : undefined,
    );
    await expect(upgrade(ctx)).rejects.toMatchObject({ step: 'pull' });
    expect(docker.commands.some((c) => c.startsWith('compose stop'))).toBe(false);
    expect((await readState(dataDir))?.version).toBe('v1.0.0');
  });

  it('rolls back to the previous version and data when the new version does not come up', async () => {
    let switched = false;
    const { ctx, docker, dataDir } = await from100('v1.1.0', (cmd) => {
      if (cmd === 'compose up -d' && !switched) {
        switched = true;
        return undefined;
      }
      if (cmd.startsWith('compose ps') && switched && !docker.commands.some((c) => c.includes('pg_restore'))) {
        return { stdout: psLines({ migrate: { state: 'exited', exitCode: 1 } }) };
      }
      return undefined;
    });
    await expect(upgrade(ctx)).rejects.toBeInstanceOf(StepError);
    expect(docker.commands).toContain('compose exec -T postgres pg_restore -U agile -d agile --exit-on-error');
    expect((await envOf(dataDir)).get('WEB_IMAGE')).toBe('registry.example.com/agile/web:v1.0.0');
    const state = await readState(dataDir);
    expect(state?.version).toBe('v1.0.0');
    expect(state?.history.at(-1)).toMatchObject({ to: 'v1.1.0', result: 'rolled_back' });
  });

  it('refuses a downgrade', async () => {
    const { ctx, docker } = await from100('v0.9.0');
    await expect(upgrade(ctx)).rejects.toBeInstanceOf(UsageError);
    expect(docker.commands).toEqual([]);
  });

  it('does nothing on the same release', async () => {
    const { ctx, docker, out } = await from100('v1.0.0');
    await upgrade(ctx);
    expect(docker.commands).toEqual([]);
    expect(out.at(-1)).toMatch(/Already on v1\.0\.0/);
  });

  it('refuses to upgrade an unhealthy stack', async () => {
    const { ctx, docker } = await from100('v1.1.0', (cmd) =>
      cmd.startsWith('compose ps') ? { stdout: psLines({ web: { state: 'exited' } }) } : undefined,
    );
    await expect(upgrade(ctx)).rejects.toBeInstanceOf(UsageError);
    expect(docker.commands).toEqual(['compose ps -a --format json']);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project operator`
Expected: FAIL, `./upgrade` not found.

- [ ] **Step 3: Implement `apps/operator/src/commands/upgrade.ts`**

```ts
import { chmod, copyFile, cp, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Context } from '../context';
import { Compose, parsePs, registryLogin, servicesOf, stackHealth, waitHealthy } from '../docker';
import { parseEnv, renderEnv } from '../env-file';
import { StepError, UsageError } from '../errors';
import { compareVersions, imagesFor, isRelease, writeStack } from '../stack';
import {
  acquireLock,
  type HistoryEntry,
  type InstallState,
  pathsOf,
  readState,
  writeSecretFile,
  writeState,
} from '../state';
import { restoreDatabase, takeBackup } from './backup';

async function record(ctx: Context, state: InstallState, to: string, result: HistoryEntry['result']) {
  const entry = { from: state.version, to, at: ctx.now().toISOString(), result };
  await writeState(ctx.dataDir, {
    ...state,
    version: result === 'ok' ? to : state.version,
    history: [...state.history, entry],
  });
}

/** Back to the files and data of `backupDir`, on the images still on this host. */
async function rollback(ctx: Context, state: InstallState, compose: Compose, backupDir: string) {
  const p = pathsOf(ctx.dataDir);
  await compose.run(['stop', 'web', 'worker', 'migrate']);
  await cp(join(backupDir, 'compose'), p.compose, { recursive: true, force: true });
  await copyFile(join(backupDir, '.env'), p.env);
  await chmod(p.env, 0o600);
  await restoreDatabase(compose, join(backupDir, 'db.dump'));
  await compose.check('rollback', ['up', '-d']);
  await waitHealthy(ctx, compose, state.mode);
}

/** Upgrades the install to this operator's version. */
export async function upgrade(ctx: Context): Promise<void> {
  const release = await acquireLock(ctx.dataDir, ctx.now());
  try {
    const state = await readState(ctx.dataDir);
    if (!state) throw new UsageError('No install in this folder: run `install`.');
    const target = ctx.build.ref;
    if (isRelease(target) && isRelease(state.version)) {
      const order = compareVersions(target, state.version);
      if (order === 0) {
        ctx.out(`Already on ${target}.`);
        return;
      }
      if (order < 0) {
        throw new UsageError(
          `${state.version} is installed, newer than this operator (${target}): migrations only go forward. Use a newer operator, or restore a backup.`,
        );
      }
    }

    const p = pathsOf(ctx.dataDir);
    const compose = new Compose(ctx.docker, ctx.dataDir, state.mode);
    const ps = await compose.check('status', ['ps', '-a', '--format', 'json']);
    if (!stackHealth(parsePs(ps.stdout), servicesOf(state.mode)).ready) {
      throw new UsageError('The stack is not healthy: fix it first (see `status`), then upgrade.');
    }

    const envText = await readFile(p.env, 'utf8');
    await registryLogin(ctx, parseEnv(envText));
    // Pulled before anything stops: a failed pull changes nothing.
    const images = imagesFor(ctx.build);
    for (const image of [images.migrate, images.web, images.worker]) {
      const r = await ctx.docker.run(['pull', image]);
      if (r.code !== 0) throw new StepError('pull', `could not pull ${image}`);
    }
    ctx.out('✓ new images pulled');

    // The app stops before the backup, so the backup holds every change.
    await compose.check('stop', ['stop', 'web', 'worker']);
    let backupDir: string;
    try {
      backupDir = await takeBackup(ctx, state, compose);
    } catch (e) {
      await compose.run(['up', '-d']);
      throw e;
    }
    ctx.out(`✓ backup ${basename(backupDir)}`);

    try {
      await writeStack(ctx.dataDir, state.mode, ctx.assetsDir);
      await writeSecretFile(
        p.env,
        renderEnv({ WEB_IMAGE: images.web, WORKER_IMAGE: images.worker, MIGRATE_IMAGE: images.migrate }, envText),
      );
      await compose.check('start', ['up', '-d']);
      await waitHealthy(ctx, compose, state.mode);
    } catch (e) {
      ctx.out(`✗ ${target} did not come up: rolling back to ${state.version}`);
      try {
        await rollback(ctx, state, compose, backupDir);
      } catch {
        await record(ctx, state, target, 'rollback_failed');
        throw new StepError(
          'rollback',
          `the rollback failed too: run \`restore ${basename(backupDir)}\``,
        );
      }
      await record(ctx, state, target, 'rolled_back');
      ctx.out(`✓ back on ${state.version}`);
      throw e;
    }
    await record(ctx, state, target, 'ok');
    ctx.out(`✓ upgraded to ${target}`);
  } finally {
    await release();
  }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run --project operator`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write apps/operator
git add apps/operator
git commit -m "feat(operator): upgrade with a backup first and roll back on failure"
```

---

### Task 8: `status`, `config`, `logs` and the CLI

**Files:**
- Create: `apps/operator/src/commands/status.ts`, `apps/operator/src/commands/config.ts`, `apps/operator/src/commands/logs.ts`, `apps/operator/src/main.ts`, `apps/operator/src/cli.ts`
- Test: `apps/operator/src/commands/status.test.ts`, `apps/operator/src/commands/config.test.ts`, `apps/operator/src/main.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `status(ctx)`; `CONFIG_KEYS`; `config(ctx, key, value)`; `logs(ctx, service: string | undefined, follow: boolean)`; `main(argv: string[], ctx: Context): Promise<number>`; `cli.ts` (entry point, builds the real `Context`).

- [ ] **Step 1: Write the failing tests**

`apps/operator/src/commands/status.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { tempContext } from '../testing';
import { backupCommand } from './backup';
import { install } from './install';
import { status } from './status';

describe('status', () => {
  it('shows version, URL, services and the last backup, never a secret', async () => {
    const { ctx, out } = await tempContext();
    await install(ctx, { port: '3100' }, { yes: true, resume: false });
    await backupCommand(ctx);
    out.length = 0;
    await status(ctx);
    const text = out.join('\n');
    expect(text).toMatch(/Version\s+v1\.0\.0 \(local\)/);
    expect(text).toMatch(/URL\s+http:\/\/localhost:3100/);
    expect(text).toMatch(/web\s+running\s+healthy/);
    expect(text).toMatch(/Backup\s+2026-10-06T12-00/);
    expect(text).not.toMatch(/[0-9a-f]{48}/);
  });
});
```

`apps/operator/src/commands/config.test.ts`:
```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../env-file';
import { UsageError } from '../errors';
import { SettingsError } from '../settings';
import { tempContext } from '../testing';
import { config } from './config';
import { install } from './install';

describe('config', () => {
  it('changes one setting and recreates only the services that read it', async () => {
    const { ctx, docker, dataDir } = await tempContext();
    await install(ctx, {}, { yes: true, resume: false });
    docker.calls.length = 0;
    await config(ctx, 'jira-hosts', 'Jira.Corp.local,portail.agir.orange.com');
    const env = parseEnv(await readFile(join(dataDir, '.env'), 'utf8'));
    expect(env.get('MCP_ALLOWED_URL_DOMAINS')).toBe('jira.corp.local,portail.agir.orange.com');
    expect(docker.commands[0]).toBe('compose up -d mcp-atlassian mcp-atlassian-readonly worker');
  });

  it('moves the port and the sign-in URL together', async () => {
    const { ctx, dataDir } = await tempContext();
    await install(ctx, {}, { yes: true, resume: false });
    await config(ctx, 'port', '3200');
    const env = parseEnv(await readFile(join(dataDir, '.env'), 'utf8'));
    expect([env.get('WEB_PORT'), env.get('BETTER_AUTH_URL')]).toEqual(['3200', 'http://localhost:3200']);
  });

  it('refuses unknown keys, keys of the other mode and bad values', async () => {
    const { ctx } = await tempContext();
    await install(ctx, {}, { yes: true, resume: false });
    await expect(config(ctx, 'POSTGRES_PASSWORD', 'x')).rejects.toBeInstanceOf(UsageError);
    await expect(config(ctx, 'domain', 'c.example.com')).rejects.toBeInstanceOf(UsageError);
    await expect(config(ctx, 'private-hosts', 'a b')).rejects.toBeInstanceOf(SettingsError);
  });
});
```

`apps/operator/src/main.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { main } from './main';
import { tempContext } from './testing';

describe('main', () => {
  it('exits 2 with usage on an unknown command or flag', async () => {
    const { ctx, out } = await tempContext();
    expect(await main(['frobnicate'], ctx)).toBe(2);
    expect(out.join('\n')).toMatch(/Usage/);
    expect(await main(['install', '--nope'], ctx)).toBe(2);
  });

  it('exits 2 on a refused setting, 0 on success, 1 on a failed step', async () => {
    const ok = await tempContext();
    expect(await main(['install', '--yes', '--port', '99999'], ok.ctx)).toBe(2);
    expect(await main(['install', '--yes'], ok.ctx)).toBe(0);
    const failing = await tempContext({
      respond: (cmd) => (cmd === 'compose pull' ? { code: 1, stderr: 'denied' } : undefined),
    });
    expect(await main(['install', '--yes'], failing.ctx)).toBe(1);
    expect(failing.out.join('\n')).toMatch(/pull failed/);
  });

  it('redacts secrets from failure details', async () => {
    const { ctx, out, dataDir } = await tempContext({
      respond: (cmd) => (cmd === 'compose up -d' ? { code: 1, stderr: 'LEAK' } : undefined),
    });
    // The fake echoes the database password in the error: it must not reach the output.
    let leaked = '';
    ctx.docker = {
      run: async (args, opts) => {
        const { readFile } = await import('node:fs/promises');
        const env = await readFile(`${dataDir}/.env`, 'utf8').catch(() => '');
        leaked = /POSTGRES_PASSWORD=(\w+)/.exec(env)?.[1] ?? leaked;
        const isUp = args.includes('up');
        return { code: isUp ? 1 : 0, stdout: '', stderr: isUp ? `password ${leaked} rejected` : '' };
      },
    };
    expect(await main(['install', '--yes'], ctx)).toBe(1);
    expect(leaked).not.toBe('');
    expect(out.join('\n')).not.toContain(leaked);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project operator`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`apps/operator/src/commands/status.ts`:
```ts
import { readFile } from 'node:fs/promises';
import type { Context } from '../context';
import { Compose, parsePs, servicesOf } from '../docker';
import { parseEnv } from '../env-file';
import { UsageError } from '../errors';
import { pathsOf, readState } from '../state';
import { listBackups } from './backup';

export async function status(ctx: Context): Promise<void> {
  const state = await readState(ctx.dataDir);
  if (!state) throw new UsageError('No install in this folder: run `install`.');
  const p = pathsOf(ctx.dataDir);
  const env = parseEnv(await readFile(p.env, 'utf8'));
  ctx.out(`Version  ${state.version} (${state.mode})`);
  ctx.out(`URL      ${env.get('BETTER_AUTH_URL') ?? '?'}`);
  const ps = await new Compose(ctx.docker, ctx.dataDir, state.mode).run(['ps', '-a', '--format', 'json']);
  const states = parsePs(ps.stdout);
  for (const service of servicesOf(state.mode)) {
    const s = states.find((x) => x.service === service);
    const detail = s ? `${s.state}${s.health ? `  ${s.health}` : ''}` : 'missing';
    ctx.out(`  ${service.padEnd(24)}${detail}`);
  }
  ctx.out(`Backup   ${(await listBackups(p.backups)).at(-1) ?? 'none'}`);
  const last = state.history.at(-1);
  if (last) ctx.out(`Upgrade  ${last.from} → ${last.to}: ${last.result} (${last.at})`);
}
```

`apps/operator/src/commands/config.ts`:
```ts
import { readFile } from 'node:fs/promises';
import type { Context } from '../context';
import { Compose, waitHealthy } from '../docker';
import { renderEnv } from '../env-file';
import { UsageError } from '../errors';
import { type Mode, parseHostList, validateSettings } from '../settings';
import { acquireLock, pathsOf, readState, writeSecretFile } from '../state';

const integer = (key: string, min: number, max: number) => (v: string) => {
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) {
    throw new UsageError(`${key} must be a number from ${min} to ${max}.`);
  }
  return v;
};

/** What `config` may change, the .env keys each sets and the services that read them. */
export const CONFIG_KEYS: Record<
  string,
  { modes: Mode[]; services: string[]; values: (v: string) => Record<string, string> }
> = {
  'jira-hosts': {
    modes: ['local', 'server'],
    services: ['mcp-atlassian', 'mcp-atlassian-readonly', 'worker'],
    values: (v) => ({ MCP_ALLOWED_URL_DOMAINS: parseHostList('jira-hosts', v).join(',') }),
  },
  'private-hosts': {
    modes: ['local', 'server'],
    services: ['web', 'worker'],
    values: (v) => ({ ALLOWED_PRIVATE_HOSTS: parseHostList('private-hosts', v).join(',') }),
  },
  'trusted-proxy-hops': {
    modes: ['local', 'server'],
    services: ['web'],
    values: (v) => ({ TRUSTED_PROXY_HOPS: integer('trusted-proxy-hops', 0, 5)(v) }),
  },
  'skill-runs-daily-limit': {
    modes: ['local', 'server'],
    services: ['web', 'worker'],
    values: (v) => ({ SKILL_RUNS_DAILY_LIMIT: integer('skill-runs-daily-limit', 1, 10_000)(v) }),
  },
  port: {
    modes: ['local'],
    services: ['web', 'worker'],
    values: (v) => {
      const port = validateSettings({ port: v }).port;
      return { WEB_PORT: String(port), BETTER_AUTH_URL: `http://localhost:${port}` };
    },
  },
  domain: {
    modes: ['server'],
    services: ['web', 'worker', 'caddy'],
    values: (v) => {
      const s = validateSettings({ mode: 'server', domain: v, 'acme-email': 'unused@example.com' });
      return { APP_DOMAIN: s.domain ?? '', BETTER_AUTH_URL: `https://${s.domain}` };
    },
  },
};

export async function config(ctx: Context, key: string, value: string): Promise<void> {
  const release = await acquireLock(ctx.dataDir, ctx.now());
  try {
    const state = await readState(ctx.dataDir);
    if (!state) throw new UsageError('No install in this folder: run `install`.');
    const spec = CONFIG_KEYS[key];
    if (!spec) throw new UsageError(`Unknown setting "${key}". Settings: ${Object.keys(CONFIG_KEYS).join(', ')}.`);
    if (!spec.modes.includes(state.mode)) {
      throw new UsageError(`"${key}" does not apply to a ${state.mode} install.`);
    }
    const values = spec.values(value);
    const p = pathsOf(ctx.dataDir);
    await writeSecretFile(p.env, renderEnv(values, await readFile(p.env, 'utf8')));
    const compose = new Compose(ctx.docker, ctx.dataDir, state.mode);
    await compose.check('restart', ['up', '-d', ...spec.services]);
    await waitHealthy(ctx, compose, state.mode);
    ctx.out(`✓ ${key} changed; restarted ${spec.services.join(', ')}`);
  } finally {
    await release();
  }
}
```

`apps/operator/src/commands/logs.ts`:
```ts
import { readFile } from 'node:fs/promises';
import type { Context } from '../context';
import { Compose } from '../docker';
import { parseEnv, redact, secretValues } from '../env-file';
import { UsageError } from '../errors';
import { pathsOf, readState } from '../state';

/** The stack's logs with the secret values of .env masked, line by line. */
export async function logs(ctx: Context, service: string | undefined, follow: boolean): Promise<void> {
  const state = await readState(ctx.dataDir);
  if (!state) throw new UsageError('No install in this folder: run `install`.');
  const secrets = secretValues(parseEnv(await readFile(pathsOf(ctx.dataDir).env, 'utf8')));
  let pending = '';
  const onStdout = (chunk: string) => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) ctx.out(redact(line, secrets));
  };
  const args = ['logs', '--no-color', '--tail', '200', ...(follow ? ['--follow'] : []), ...(service ? [service] : [])];
  await new Compose(ctx.docker, ctx.dataDir, state.mode).check('logs', args, { onStdout });
  if (pending) ctx.out(redact(pending, secrets));
}
```

`apps/operator/src/main.ts`:
```ts
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { backupCommand, restoreCommand } from './commands/backup';
import { config } from './commands/config';
import { install } from './commands/install';
import { logs } from './commands/logs';
import { status } from './commands/status';
import { upgrade } from './commands/upgrade';
import type { Context } from './context';
import { parseEnv, redact, secretValues } from './env-file';
import { StepError, UsageError } from './errors';
import { type RawSettings, SETTING_KEYS, SettingsError } from './settings';
import { LockedError, pathsOf } from './state';

export const USAGE = `Usage: operator <command> [options]

  install [--yes] [--resume] [--mode local|server] [--port N] [--domain D] [--acme-email E]
          [--jira-hosts H,..] [--private-hosts H,..] [--registry-user U --registry-token T]
          [--oidc-provider keycloak|oidc --oidc-issuer URL --oidc-client-id ID --oidc-client-secret S]
  upgrade              upgrade to this operator's version (backup first, rollback on failure)
  status               version, services, last backup and upgrade
  backup               back up the database with .env and the compose files
  restore <name|latest> [--yes]
  config <setting> <value>
  logs [service] [--follow]`;

async function secretsOf(ctx: Context): Promise<string[]> {
  const text = await readFile(pathsOf(ctx.dataDir).env, 'utf8').catch(() => '');
  return secretValues(parseEnv(text));
}

/** Runs one command. Exit codes: 0 success, 1 a step failed, 2 usage or a refused value. */
export async function main(argv: string[], ctx: Context): Promise<number> {
  const [command, ...rest] = argv;
  try {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: {
        yes: { type: 'boolean', default: false },
        resume: { type: 'boolean', default: false },
        follow: { type: 'boolean', default: false },
        ...Object.fromEntries(SETTING_KEYS.map((k) => [k, { type: 'string' as const }])),
      },
    });
    const yes = Boolean(values.yes);
    switch (command) {
      case 'install': {
        const raw: RawSettings = {};
        for (const k of SETTING_KEYS) {
          const v = values[k];
          if (typeof v === 'string') raw[k] = v;
        }
        await install(ctx, raw, { yes, resume: Boolean(values.resume) });
        return 0;
      }
      case 'upgrade':
        await upgrade(ctx);
        return 0;
      case 'status':
        await status(ctx);
        return 0;
      case 'backup':
        await backupCommand(ctx);
        return 0;
      case 'restore':
        if (!positionals[0]) throw new UsageError('restore needs a backup name, or `latest`.');
        await restoreCommand(ctx, positionals[0], { yes });
        return 0;
      case 'config':
        if (positionals.length !== 2) throw new UsageError('config needs a setting and a value.');
        await config(ctx, positionals[0] ?? '', positionals[1] ?? '');
        return 0;
      case 'logs':
        await logs(ctx, positionals[0], Boolean(values.follow));
        return 0;
      default:
        ctx.out(USAGE);
        return 2;
    }
  } catch (e) {
    if (e instanceof StepError) {
      const detail = redact(e.detail, await secretsOf(ctx));
      ctx.out(`✗ ${e.step} failed${detail ? `: ${detail}` : ''}`);
      return 1;
    }
    if (e instanceof LockedError) {
      ctx.out(`✗ ${e.message}`);
      return 1;
    }
    if (e instanceof UsageError || e instanceof SettingsError) {
      ctx.out(`✗ ${e.message}`);
      return 2;
    }
    if ((e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      ctx.out(`✗ ${(e as Error).message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
}
```

`apps/operator/src/cli.ts`:
```ts
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { Context } from './context';
import { realDocker } from './docker';
import { main } from './main';
import type { Prompter } from './settings';

/** Prompts on the terminal; a secret answer is not echoed. */
const terminal: Prompter = {
  async ask(question, o = {}) {
    let muted = false;
    const output = new Writable({
      write(chunk, _encoding, done) {
        if (!muted) process.stdout.write(chunk);
        done();
      },
    });
    const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
    const pending = rl.question(`? ${question}${o.default ? ` [${o.default}]` : ''}: `);
    muted = Boolean(o.secret);
    const answer = (await pending).trim();
    rl.close();
    if (o.secret) process.stdout.write('\n');
    return answer || o.default || '';
  },
  async confirm(question) {
    return /^y(es)?$/i.test(await terminal.ask(`${question} (yes/no)`, { default: 'no' }));
  },
};

const here = dirname(fileURLToPath(import.meta.url));
const ctx: Context = {
  dataDir: process.env.OPERATOR_DATA_DIR ?? '/data',
  assetsDir: process.env.OPERATOR_ASSETS_DIR ?? join(here, '..', 'assets'),
  build: {
    ref: process.env.OPERATOR_VERSION ?? 'develop',
    imageBase:
      process.env.OPERATOR_IMAGE_BASE ?? 'registry.gitlab.tech.orange/mohamedamine.belhajja/jira-agentic-ai',
  },
  docker: realDocker,
  out: (line) => console.log(line),
  prompt: terminal,
  now: () => new Date(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  healthTimeoutMs: 5 * 60 * 1000,
};

process.exitCode = await main(process.argv.slice(2), ctx);
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run --project operator && (cd apps/operator && npx tsc --noEmit -p tsconfig.json)`
Expected: PASS, no type errors.

- [ ] **Step 5: Bundle once to check it builds**

Run: `node scripts/bundle-node.mjs apps/operator/src/cli.ts "$TMP/operator.mjs" && OPERATOR_DATA_DIR="$TMP/empty" node "$TMP/operator.mjs" status; echo "exit=$?"`
Expected: `✗ No install in this folder: run \`install\`.` and `exit=2`.

- [ ] **Step 6: Commit**

```bash
npx biome check --write apps/operator
git add apps/operator
git commit -m "feat(operator): add status, config, logs and the command line"
```

---

### Task 9: The operator image, CI and docs

**Files:**
- Modify: `apps/web/Dockerfile` (bundle stage, new `operator` stage)
- Modify: `.gitlab-ci.yml` (`.docker-base` matrix entry)
- Modify: `packages/jira-tools/src/helm.test.ts:60-81` (the operator is a final stage the chart does not deploy)
- Modify: `README.md` (an "Install with the operator" section)

**Interfaces:**
- Consumes: `apps/operator/src/cli.ts` (Task 8); the env variables it reads (`OPERATOR_DATA_DIR`, `OPERATOR_ASSETS_DIR`, `OPERATOR_VERSION`, `OPERATOR_IMAGE_BASE`).
- Produces: image target `operator`; registry images `<base>/operator/snapshot:<slug>` and `<base>/operator:<tag>`.

- [ ] **Step 1: Update the Helm test first (it reads the Dockerfile)**

In `packages/jira-tools/src/helm.test.ts`, replace the final-stage check:
```ts
  // Final images: stages no other stage builds on. The chart deploys runner, worker and migrate;
  // the operator drives Docker through its socket on a Docker host and is never deployed by it.
  const finals = stages.filter((s) => !used.has(nameOf(s)));
  const deployed = finals.filter((s) => nameOf(s) !== 'operator');

  it('runs every image the chart deploys as the numeric user the chart expects', () => {
    expect(finals.map(nameOf).sort()).toEqual(['migrate', 'operator', 'runner', 'worker']);
    const podUser = (parse(chart('values.yaml')) as { podSecurityContext: { runAsUser: number } })
      .podSecurityContext.runAsUser;
    for (const stage of deployed) {
      const users = [...stage.matchAll(/^USER (.+)$/gm)].map((m) => m[1]);
      expect(users.at(-1), nameOf(stage)).toBe(`${podUser}:${podUser}`);
    }
    // No user name anywhere: names cannot be checked against runAsNonRoot.
    for (const [, user] of dockerfile.matchAll(/^USER (.+)$/gm)) expect(user).toMatch(/^\d+:\d+$/);
  });
```

Run: `npx vitest run packages/jira-tools/src/helm.test.ts`
Expected: FAIL (`operator` not in the finals yet).

- [ ] **Step 2: Add the operator to the Dockerfile**

In the `bundle` stage, extend the `RUN` with:
```dockerfile
  && node scripts/bundle-node.mjs apps/operator/src/cli.ts /out/operator/dist/operator.mjs
```

At the end of the file:
```dockerfile
# The operator: installs and upgrades the stack on a Docker host through the mounted socket
# (docker run -v /var/run/docker.sock:/var/run/docker.sock -v <folder>:/data <image> install).
FROM runtime AS operator
# hadolint ignore=DL3018
RUN apk add --no-cache docker-cli docker-cli-compose
ARG OPERATOR_VERSION=develop
ARG OPERATOR_IMAGE_BASE=registry.gitlab.tech.orange/mohamedamine.belhajja/jira-agentic-ai
ENV OPERATOR_VERSION=$OPERATOR_VERSION OPERATOR_IMAGE_BASE=$OPERATOR_IMAGE_BASE \
  OPERATOR_DATA_DIR=/data
WORKDIR /opt/operator
COPY --from=bundle /out/operator ./
COPY docker-compose.selfhost.yml docker-compose.server.yml assets/
COPY docker/postgres/init/01-app-role.sh assets/postgres-init.sh
COPY docker/caddy/Caddyfile assets/Caddyfile
# Root on purpose: the Docker socket it drives is root-equivalent anyway.
# hadolint ignore=DL3002
USER 0:0
ENTRYPOINT ["node", "/opt/operator/dist/operator.mjs"]
```

Run: `npx vitest run packages/jira-tools/src/helm.test.ts`
Expected: PASS.

Run: `MSYS_NO_PATHCONV=1 docker run --rm -i hadolint/hadolint < apps/web/Dockerfile && echo ok`
Expected: `ok`.

- [ ] **Step 3: Build and try the image**

Run:
```bash
docker build -f apps/web/Dockerfile --target operator -t agile-local/operator:dev .
docker images agile-local/operator:dev --format '{{.Size}}'
docker run --rm agile-local/operator:dev; echo "exit=$?"
```
Expected: about 270 MB; the usage text and `exit=2`.

- [ ] **Step 4: Publish it from CI**

In `.gitlab-ci.yml`, add to the `.docker-base` matrix:
```yaml
      - DOCKER_ARTIFACTS_NAMESPACE: operator
        DOCKER_BUILD_ARGS: >-
          --target operator --build-arg OPERATOR_VERSION=$CI_COMMIT_REF_NAME
          --build-arg OPERATOR_IMAGE_BASE=$CI_REGISTRY_IMAGE
        DOCKER_SNAPSHOT_IMAGE: $CI_REGISTRY_IMAGE/operator/snapshot:$CI_COMMIT_REF_SLUG
        DOCKER_RELEASE_IMAGE: $CI_REGISTRY_IMAGE/operator:$CI_COMMIT_REF_NAME
        DOCKER_BUILD_CACHE_LOCATION: $CI_REGISTRY_IMAGE/operator/cache
```

- [ ] **Step 5: Document it**

Add to `README.md`, before "Deploying on a server":
````markdown
## Install with the operator

The operator installs and upgrades the self-host stack on any Docker host inside the Orange
network. It keeps everything (settings, secrets, compose files, backups) in one folder you choose.

```bash
docker run --rm -it \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/agile-copilot:/data \
  registry.gitlab.tech.orange/mohamedamine.belhajja/jira-agentic-ai/operator:<version> install
```

It asks for the mode (`local`: this computer, `server`: HTTPS with a domain), the port or domain,
the Jira hosts to allow and a registry deploy token, generates every secret, starts the stack and
waits until it is healthy. Every answer can be given as a flag (`--yes` takes the defaults).

- `upgrade` (run the operator of the new version): pulls, backs up, migrates, and rolls back to
  the previous version and data if the new one does not come up.
- `status`, `backup`, `restore <name|latest>`, `config <setting> <value>`, `logs [service]`.
- Keep the folder backed up: its `.env` holds `ENCRYPTION_KEYS`, without which the stored Jira and
  AI credentials cannot be read.
- The operator runs as root in its container: it drives the Docker socket, which is
  root-equivalent anyway.
- A hand-made install moves under the operator by copying its `.env` into the folder's `.env`
  before `install --resume`; the secrets carry over.
````

- [ ] **Step 6: Commit**

```bash
git add apps/web/Dockerfile .gitlab-ci.yml packages/jira-tools/src/helm.test.ts README.md
git commit -m "build(operator): ship the operator image and publish it from CI"
```

---

### Task 10: Integration test against a real Docker

**Files:**
- Create: `apps/operator/it/run.sh`
- Modify: `.gitlab-ci.yml` (job `operator-it`)

**Interfaces:**
- Consumes: the operator image (Task 9) and the published web/worker/migrate snapshot images of the same commit.
- Produces: a CI job proving install, upgrade, rollback and restore on a real daemon.

- [ ] **Step 1: Write the script**

`apps/operator/it/run.sh`:
```sh
#!/bin/sh
# End-to-end check of the operator on a real Docker daemon: install, upgrade, a failed upgrade
# rolled back, backup and restore. Images are re-tagged into a local registry (localhost:5000) as
# versions v0.0.1, v0.0.2 and a broken v0.0.3 (its migrate exits 1), so pulls are real.
# Usage: run.sh <registry image base> <ref slug>   (needs docker; DOCKER_HOST may be remote)
set -eu
BASE=$1
SLUG=$2
LOCAL=localhost:5000/agile
OP="$BASE/operator/snapshot:$SLUG"

cleanup() {
  docker ps -aq --filter label=com.docker.compose.project=agile-copilot | xargs -r docker rm -f
  docker volume ls -q --filter label=com.docker.compose.project=agile-copilot | xargs -r docker volume rm
  docker rm -f opit-registry >/dev/null 2>&1 || true
  docker volume rm opit-data >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker run -d --name opit-registry -p 5000:5000 registry:2 >/dev/null
for svc in web worker migrate; do
  docker pull -q "$BASE/$svc/snapshot:$SLUG"
  for v in v0.0.1 v0.0.2 v0.0.3; do
    docker tag "$BASE/$svc/snapshot:$SLUG" "$LOCAL/$svc:$v"
  done
done
printf 'FROM alpine:3.24\nCMD ["false"]\n' | docker build -q -t "$LOCAL/migrate:v0.0.3" -
for svc in web worker migrate; do
  for v in v0.0.1 v0.0.2 v0.0.3; do docker push -q "$LOCAL/$svc:$v" >/dev/null; done
done
docker pull -q "$OP"

op() {
  version=$1
  shift
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v opit-data:/data \
    -e OPERATOR_VERSION="$version" -e OPERATOR_IMAGE_BASE="$LOCAL" "$OP" "$@"
}
sql() { docker exec agile-copilot-postgres-1 psql -U agile -d agile -tAc "$1"; }
healthy() { docker exec agile-copilot-web-1 wget -qO- http://127.0.0.1:3000/healthz >/dev/null; }

echo '--- install v0.0.1'
op v0.0.1 install --yes --mode local --port 3000
healthy
sql "create table it_marker (v text); insert into it_marker values ('kept')"

echo '--- upgrade to v0.0.2'
op v0.0.2 upgrade
healthy
test "$(sql 'select v from it_marker')" = kept
op v0.0.2 status | grep -q 'v0.0.2 (local)'

echo '--- upgrade to the broken v0.0.3 rolls back'
if op v0.0.3 upgrade; then echo 'the broken upgrade succeeded' >&2; exit 1; fi
healthy
test "$(sql 'select v from it_marker')" = kept
op v0.0.3 status | grep -q 'v0.0.2 (local)'
op v0.0.3 status | grep -q 'rolled_back'

echo '--- backup and restore'
op v0.0.2 backup
sql 'delete from it_marker'
op v0.0.2 restore latest --yes
test "$(sql 'select v from it_marker')" = kept
healthy
echo 'operator integration: ok'
```

- [ ] **Step 2: Run it locally**

Run (logged in to the registry, Docker Desktop running, after a pipeline published the
snapshot images of this branch):
```bash
sh apps/operator/it/run.sh registry.gitlab.tech.orange/mohamedamine.belhajja/jira-agentic-ai feat-operator
```
Expected: ends with `operator integration: ok`.

- [ ] **Step 3: Add the CI job**

In `.gitlab-ci.yml`, after the `e2e` job:
```yaml
# The operator on a real Docker daemon: install, upgrade, a failed upgrade rolled back, restore.
operator-it:
  stage: acceptance
  image: docker:28-cli
  tags: [graas-dind]
  services:
    - name: docker:28-dind
      alias: docker
  variables:
    DOCKER_HOST: tcp://docker:2375
    DOCKER_TLS_CERTDIR: ""
  script:
    - echo "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin "$CI_REGISTRY"
    - sh apps/operator/it/run.sh "$CI_REGISTRY_IMAGE" "$CI_COMMIT_REF_SLUG"
```

- [ ] **Step 4: Commit**

```bash
git add apps/operator/it/run.sh .gitlab-ci.yml
git commit -m "test(operator): run install, upgrade, rollback and restore on a real Docker"
```
