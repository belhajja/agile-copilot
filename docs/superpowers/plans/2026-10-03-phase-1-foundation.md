# Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A self-hostable, multi-tenant web app where a manager signs up, creates a workspace, and connects Jira (Cloud via OAuth or API token, Data Center via PAT) and an LLM of their choice (BYOK) — with credentials encrypted per tenant, tenant isolation enforced by Postgres RLS, and every connection change audit-logged.

**Architecture:** pnpm/Turborepo monorepo. Domain logic lives in small framework-free packages (`config`, `crypto`, `db`, `auth`, `net`, `jira`, `llm`, `connections`) that are unit/integration-tested in isolation; `apps/web` (Next.js 16) is a thin layer of pages, server actions and route handlers over `@agile/connections`. Packages ship TypeScript source (no build step); Next transpiles them.

**Tech Stack:** Node 24, pnpm 10.14, TypeScript 7.0.2, Next.js 16.3.8, React 19.3, better-auth 1.7.7 (organization plugin), drizzle-orm 0.45.3 + drizzle-kit 0.31.11 + postgres.js 3.4.9, PostgreSQL 17, AI SDK 7 (`ai` 7.0.x + `@ai-sdk/*` 4.x / openai-compatible 3.x), jira.js 6.2 (Cloud) + jira.js 5.4 aliased as `jira-js-v5` (Data Center), arctic 3.7 (Atlassian OAuth), zod 4.6, next-intl 4.14, Tailwind 4.3 + shadcn/ui 4.21 (Radix base, blocks `login-03`/`signup-03`/`sidebar-07`), Vitest 5.0.3 (+ vite 8.3.2 peer), Testcontainers 12.2, Playwright 1.63, Biome 2.5.15.

**Spec:** `docs/superpowers/specs/2026-10-03-agile-copilot-design.md` (Phase 1 = "Foundation"; see also "Jira auth & MCP topology").

## Global Constraints

- Node `>=24`; pnpm `10.14.0`; every package is `"type": "module"` (jira.js 6, pg-boss 12, better-auth are ESM-only).
- Exact dependency versions as listed in Tech Stack; `skipLibCheck: true` is required (library `.d.ts` files do not type-check otherwise).
- Lint/format with **Biome only** — typescript-eslint needs the TS JS API, which TypeScript 7 no longer ships.
- better-auth ids are random **text**, so every `org_id`/`user_id` column is `text`, never `uuid`.
- Every tenant-owned table has `org_id text not null` + an RLS policy on `current_setting('app.current_org_id', true)`, and is accessed only inside `withOrg(db, orgId, fn)`.
- The app connects as role **`app_user`** (non-owner, so RLS applies); migrations run as the database owner via `DATABASE_OWNER_URL`. Tenant tables also get `FORCE ROW LEVEL SECURITY`.
- Secrets (Jira tokens, OAuth tokens, LLM keys) are encrypted with a per-org DEK (AES-256-GCM) wrapped by a versioned KEK from `ENCRYPTION_KEYS`; they never reach the browser, API responses, logs, error messages, or `audit_log.metadata`.
- jira.js **v6 is Cloud-only**; Data Center uses `jira-js-v5` (`Version2Client`, PAT sent as OAuth2 bearer).
- Auth is email + password only — no social providers. Keep it SSO-ready: identity stays in better-auth's `user`/`account` tables (never a parallel users table), and app code reads identity only through `requireActor()`, so adding Keycloak/OIDC later (better-auth `genericOAuth`) and restricting passwords to admins touches auth config, not features.
- Next.js 16: request interception lives in `src/proxy.ts` (exported `proxy`), `headers()`/`cookies()`/`params` are awaited.
- All user-facing strings come from `apps/web/messages/{en,fr}.json` (EN + FR from day one).
- **UI is shadcn/ui on the Radix base (`shadcn init --base radix`), built from shadcn blocks first** (`login-03`, `signup-03`, `sidebar-07`) and shadcn components second (`field`, `item`, `empty`, `native-select`, `radio-group`, `sonner`, …). Adapt generated block code (wire data, i18n, remove unsupported features); never hand-edit `src/components/ui/*`; no custom CSS beyond Tailwind utilities.
- Outbound URLs supplied by users (Jira base URL, OpenAI-compatible base URL) pass `checkOutboundUrl` (no private/reserved IPs unless the host is in `ALLOWED_PRIVATE_HOSTS`).
- Vitest 5: `vite` is a peer dependency; `vi.mock` only at module top level; config files are not looked up in parent dirs.

## Review Focus

1. **Empty env vars from a copied `.env.example`** (`ATLASSIAN_OAUTH_CLIENT_ID=`) must count as "unset", not crash startup — test in Task 1.
2. **Pasted Jira URLs that aren't the base URL** (trailing slash, `?query`, a Cloud board URL like `https://acme.atlassian.net/jira/software/projects/X/boards/1`, a DC `/browse/ABC-1` link, DC context path `/jira`) must normalise to the right base URL — test in Task 5.
3. **Pasted tokens with surrounding whitespace/newlines** must be trimmed before testing and storage — test in Task 5.
4. **Two connections saved at the same moment for a brand-new org** (both trying to create the org's DEK) must both succeed — test in Task 7.
5. **Two concurrent requests refreshing the same Atlassian OAuth token** (refresh tokens rotate) must refresh only once and both get a valid token — test in Task 11.

---

## File Structure

```
package.json, pnpm-workspace.yaml, turbo.json, biome.json, tsconfig.base.json, vitest.config.ts
.nvmrc, .gitignore, .env.example, docker-compose.yml, docker-compose.selfhost.yml
docker/postgres/init/01-app-role.sh        creates the non-owner app_user role
.github/workflows/ci.yml
packages/config/      src/env.ts                          zod-validated server env
packages/crypto/      src/envelope.ts                     keyring, DEK wrap/unwrap, secret encrypt/decrypt
packages/db/          src/schema/{app,auth,index}.ts      drizzle tables (+RLS policies)
                      src/client.ts                       createDb, withOrg, Db/Tx types
                      src/migrate.ts, src/migrate-cli.ts  programmatic migrator
                      src/testing.ts                      startTestDatabase() (Testcontainers)
                      drizzle/                            generated SQL + custom grants migration
packages/auth/        src/server.ts                       createAuth (better-auth + organization)
                      src/roles.ts                        getMemberRoles, canManageConnections
                      src/cli-config.ts                   config entry for `auth generate`
packages/net/         src/outbound-url.ts                 SSRF guard for user-supplied URLs
packages/jira/        src/types.ts, src/normalize.ts      credentials model, URL/credential normalisation
                      src/errors.ts                       error → failure-code mapping
                      src/probe.ts                        probeJira (Cloud v6 / DC v5)
                      src/test-connection.ts              policy + probe
                      src/oauth.ts                        Atlassian OAuth client + accessible sites
                      src/testing/mock-jira-server.ts     node:http mock Jira (tests + e2e)
packages/llm/         src/providers.ts                    LlmConfig → LanguageModel
                      src/probe.ts                        tool-calling probe + error mapping
                      src/testing/mock-openai-server.ts   node:http OpenAI-compatible mock
packages/connections/ src/actor.ts, src/errors.ts         Actor type, ForbiddenError
                      src/vault.ts                        per-org DEK get-or-create
                      src/audit.ts                        recordAudit
                      src/jira-connections.ts             create/list/retest/delete/load + OAuth
                      src/llm-connections.ts              create/list/retest/delete/setDefault/load
apps/web/             Next.js app: shadcn blocks/components (src/components), pages, server actions, route handlers, i18n
e2e/                  Playwright tests + mock-server runner
```

---

### Task 1: Monorepo scaffold, CI, and `@agile/config`

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `biome.json`, `tsconfig.base.json`, `vitest.config.ts`, `.nvmrc`, `.gitignore`, `.env.example`, `.github/workflows/ci.yml`
- Create: `packages/config/{package.json,tsconfig.json,vitest.config.ts}`, `packages/config/src/{env.ts,index.ts}`
- Test: `packages/config/src/env.test.ts`

**Interfaces:**
- Produces: `parseServerEnv(source?: Record<string, string | undefined>): ServerEnv`, `serverEnv(): ServerEnv` (memoised), `EnvError`, type `ServerEnv` with fields `NODE_ENV`, `DEPLOYMENT_MODE: 'saas' | 'selfhost'`, `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `ENCRYPTION_KEYS: string`, `ALLOWED_PRIVATE_HOSTS: string[]`, `ATLASSIAN_OAUTH_CLIENT_ID?: string`, `ATLASSIAN_OAUTH_CLIENT_SECRET?: string`.
- Convention every later package copies: `package.json` with `"exports": { ".": "./src/index.ts" }`, `"scripts": { "typecheck": "tsc -p tsconfig.json" }`; `tsconfig.json` extending `../../tsconfig.base.json`; `vitest.config.ts` using `defineProject`.

- [ ] **Step 1: Root workspace files**

`package.json`:
```json
{
  "name": "agile-copilot",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.14.0",
  "engines": { "node": ">=24" },
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "typecheck": "turbo run typecheck",
    "test": "vitest run",
    "lint": "biome check .",
    "format": "biome check --write .",
    "db:generate": "pnpm --filter @agile/db generate",
    "db:migrate": "pnpm --filter @agile/db migrate",
    "e2e": "pnpm --filter @agile/e2e test"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.15",
    "@types/node": "^24.0.0",
    "turbo": "2.11.7",
    "typescript": "7.0.2",
    "vite": "8.3.2",
    "vitest": "5.0.3"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - apps/*
  - packages/*
  - e2e
```

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": [".next/**", "!.next/cache/**"] },
    "typecheck": {},
    "dev": { "cache": false, "persistent": true }
  }
}
```

`biome.json`:
```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.15/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "formatter": { "indentStyle": "space", "lineWidth": 100 },
  "linter": { "rules": { "recommended": true } },
  "javascript": { "formatter": { "quoteStyle": "single", "semicolons": "always" } }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "types": ["node"]
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*'],
  },
});
```

`.nvmrc`: `24`

`.gitignore`:
```
node_modules/
.next/
.turbo/
.vitest/
coverage/
playwright-report/
test-results/
.env
.env.*
!.env.example
```

`.env.example`:
```bash
# Generate secrets with: openssl rand -base64 32
DEPLOYMENT_MODE=selfhost
# App connects as the non-owner role (RLS applies to it)
DATABASE_URL=postgres://app_user:app_user_dev_password@localhost:5432/agile
# Migrations run as the owner
DATABASE_OWNER_URL=postgres://agile:agile_dev_password@localhost:5432/agile
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=http://localhost:3000
# Comma-separated versioned 32-byte keys, newest version wins: v1:<base64>,v2:<base64>
ENCRYPTION_KEYS=
# Hostnames allowed to resolve to private IPs (self-hosted Jira / Ollama), e.g. jira.corp.local
ALLOWED_PRIVATE_HOSTS=
# Optional: Atlassian OAuth 2.0 (3LO) app for "Connect with Atlassian"
ATLASSIAN_OAUTH_CLIENT_ID=
ATLASSIAN_OAUTH_CLIENT_SECRET=
```

`.github/workflows/ci.yml`:
```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
```

- [ ] **Step 2: `@agile/config` package skeleton**

`packages/config/package.json`:
```json
{
  "name": "@agile/config",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc -p tsconfig.json" },
  "dependencies": { "zod": "4.6.5" }
}
```

`packages/config/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

`packages/config/vitest.config.ts`:
```ts
import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'config', environment: 'node', include: ['src/**/*.test.ts'] },
});
```

- [ ] **Step 3: Write the failing tests**

`packages/config/src/env.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { EnvError, parseServerEnv } from './env';

const valid = {
  DATABASE_URL: 'postgres://app_user:pw@localhost:5432/agile',
  BETTER_AUTH_SECRET: 's'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3000',
  ENCRYPTION_KEYS: `v1:${Buffer.alloc(32, 1).toString('base64')}`,
};

describe('parseServerEnv', () => {
  it('parses a minimal valid environment with defaults', () => {
    const env = parseServerEnv(valid);
    expect(env.DEPLOYMENT_MODE).toBe('selfhost');
    expect(env.NODE_ENV).toBe('development');
    expect(env.ALLOWED_PRIVATE_HOSTS).toEqual([]);
    expect(env.ATLASSIAN_OAUTH_CLIENT_ID).toBeUndefined();
  });

  it('treats empty strings (copied .env.example) as unset', () => {
    const env = parseServerEnv({
      ...valid,
      ALLOWED_PRIVATE_HOSTS: '',
      ATLASSIAN_OAUTH_CLIENT_ID: '',
      ATLASSIAN_OAUTH_CLIENT_SECRET: '',
    });
    expect(env.ATLASSIAN_OAUTH_CLIENT_ID).toBeUndefined();
    expect(env.ALLOWED_PRIVATE_HOSTS).toEqual([]);
  });

  it('normalises the private host allowlist', () => {
    const env = parseServerEnv({ ...valid, ALLOWED_PRIVATE_HOSTS: ' jira.corp.local, Ollama.Internal ,,' });
    expect(env.ALLOWED_PRIVATE_HOSTS).toEqual(['jira.corp.local', 'ollama.internal']);
  });

  it('lists every invalid key without echoing secret values', () => {
    const secret = 'too-short-secret-value';
    try {
      parseServerEnv({ ...valid, BETTER_AUTH_SECRET: secret, DATABASE_URL: undefined });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      const message = (e as Error).message;
      expect(message).toContain('BETTER_AUTH_SECRET');
      expect(message).toContain('DATABASE_URL');
      expect(message).not.toContain(secret);
    }
  });

  it('requires the Atlassian OAuth id and secret together', () => {
    expect(() => parseServerEnv({ ...valid, ATLASSIAN_OAUTH_CLIENT_ID: 'abc' })).toThrow(
      /ATLASSIAN_OAUTH_CLIENT_ID/,
    );
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm install && pnpm vitest run --project config`
Expected: FAIL — `Cannot find module './env'`.

- [ ] **Step 5: Implement**

`packages/config/src/env.ts`:
```ts
import { z } from 'zod';

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional());
const hostList = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );

export const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DEPLOYMENT_MODE: z.enum(['saas', 'selfhost']).default('selfhost'),
    DATABASE_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),
    ENCRYPTION_KEYS: z.string().min(1),
    ALLOWED_PRIVATE_HOSTS: hostList,
    ATLASSIAN_OAUTH_CLIENT_ID: optionalString,
    ATLASSIAN_OAUTH_CLIENT_SECRET: optionalString,
  })
  .refine((e) => Boolean(e.ATLASSIAN_OAUTH_CLIENT_ID) === Boolean(e.ATLASSIAN_OAUTH_CLIENT_SECRET), {
    message: 'ATLASSIAN_OAUTH_CLIENT_ID and ATLASSIAN_OAUTH_CLIENT_SECRET must be set together',
    path: ['ATLASSIAN_OAUTH_CLIENT_ID'],
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export class EnvError extends Error {
  override name = 'EnvError';
}

export function parseServerEnv(
  source: Record<string, string | undefined> = process.env,
): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`);
    throw new EnvError(`Invalid server environment:\n${lines.join('\n')}`);
  }
  return result.data;
}

let cached: ServerEnv | undefined;
export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv();
  return cached;
}
```

`packages/config/src/index.ts`:
```ts
export { EnvError, parseServerEnv, serverEnv, serverEnvSchema, type ServerEnv } from './env';
```

- [ ] **Step 6: Run tests, lint, typecheck**

Run: `pnpm vitest run --project config && pnpm lint && pnpm typecheck`
Expected: 5 tests PASS; Biome and tsc report no errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold monorepo with CI and validated server env"
```

---

### Task 2: `@agile/crypto` — envelope encryption

**Files:**
- Create: `packages/crypto/{package.json,tsconfig.json,vitest.config.ts}` (Task 1 convention, name `@agile/crypto`, no dependencies), `packages/crypto/src/{envelope.ts,index.ts}`
- Test: `packages/crypto/src/envelope.test.ts`

**Interfaces:**
- Produces:
  - `interface Keyring { currentVersion: number; keys: ReadonlyMap<number, Buffer> }`
  - `parseKeyring(spec: string): Keyring`
  - `interface WrappedDek { kekVersion: number; wrapped: string }`
  - `generateDek(): Buffer`
  - `wrapDek(keyring: Keyring, orgId: string, dek: Buffer): WrappedDek`
  - `unwrapDek(keyring: Keyring, orgId: string, w: WrappedDek): Buffer`
  - `encryptSecret(dek: Buffer, context: string, plaintext: string): string` (format `s1.<iv>.<tag>.<ct>`, base64url)
  - `decryptSecret(dek: Buffer, context: string, payload: string): string`
  - `class CryptoError extends Error`

- [ ] **Step 1: Write the failing tests**

`packages/crypto/src/envelope.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  CryptoError,
  decryptSecret,
  encryptSecret,
  generateDek,
  parseKeyring,
  unwrapDek,
  wrapDek,
} from './envelope';

const k = (byte: number) => Buffer.alloc(32, byte).toString('base64');

describe('parseKeyring', () => {
  it('uses the highest version as current', () => {
    const ring = parseKeyring(`v1:${k(1)}, v2:${k(2)}`);
    expect(ring.currentVersion).toBe(2);
    expect(ring.keys.size).toBe(2);
  });

  it.each([
    ['', /empty/],
    ['nope', /v1:<base64>/],
    [`v1:${Buffer.alloc(16).toString('base64')}`, /32 bytes/],
    [`v1:${k(1)},v1:${k(2)}`, /duplicate/i],
  ])('rejects %j', (spec, error) => {
    expect(() => parseKeyring(spec)).toThrow(error);
  });
});

describe('DEK wrapping', () => {
  it('round-trips and survives key rotation', () => {
    const v1 = parseKeyring(`v1:${k(1)}`);
    const dek = generateDek();
    const wrapped = wrapDek(v1, 'org_a', dek);
    expect(wrapped.kekVersion).toBe(1);

    const rotated = parseKeyring(`v1:${k(1)},v2:${k(2)}`);
    expect(unwrapDek(rotated, 'org_a', wrapped).equals(dek)).toBe(true);
    expect(wrapDek(rotated, 'org_a', dek).kekVersion).toBe(2);
  });

  it('cannot be unwrapped for another org', () => {
    const ring = parseKeyring(`v1:${k(1)}`);
    const wrapped = wrapDek(ring, 'org_a', generateDek());
    expect(() => unwrapDek(ring, 'org_b', wrapped)).toThrow(CryptoError);
  });

  it('reports a missing key version', () => {
    const wrapped = wrapDek(parseKeyring(`v3:${k(3)}`), 'org_a', generateDek());
    expect(() => unwrapDek(parseKeyring(`v1:${k(1)}`), 'org_a', wrapped)).toThrow(/v3/);
  });
});

describe('secrets', () => {
  const dek = generateDek();

  it('round-trips unicode and never contains the plaintext', () => {
    const payload = encryptSecret(dek, 'jira_connection:1', 'tökén-🔑');
    expect(payload.startsWith('s1.')).toBe(true);
    expect(payload).not.toContain('tökén');
    expect(decryptSecret(dek, 'jira_connection:1', payload)).toBe('tökén-🔑');
  });

  it('uses a fresh IV each time', () => {
    expect(encryptSecret(dek, 'c', 'x')).not.toBe(encryptSecret(dek, 'c', 'x'));
  });

  it('is bound to its context (ciphertexts cannot be swapped between rows)', () => {
    const payload = encryptSecret(dek, 'jira_connection:1', 'secret');
    expect(() => decryptSecret(dek, 'jira_connection:2', payload)).toThrow(CryptoError);
  });

  it('detects tampering and malformed input without leaking details', () => {
    const payload = encryptSecret(dek, 'c', 'secret');
    const parts = payload.split('.');
    const ct = Buffer.from(parts[3] ?? '', 'base64url');
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    parts[3] = ct.toString('base64url');
    expect(() => decryptSecret(dek, 'c', parts.join('.'))).toThrow(CryptoError);
    expect(() => decryptSecret(dek, 'c', 'garbage')).toThrow(CryptoError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run --project crypto`
Expected: FAIL — `Cannot find module './envelope'`.

- [ ] **Step 3: Implement**

`packages/crypto/src/envelope.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SECRET_PREFIX = 's1.';

export class CryptoError extends Error {
  override name = 'CryptoError';
}

export interface Keyring {
  currentVersion: number;
  keys: ReadonlyMap<number, Buffer>;
}

export interface WrappedDek {
  kekVersion: number;
  wrapped: string;
}

export function parseKeyring(spec: string): Keyring {
  const keys = new Map<number, Buffer>();
  let currentVersion = 0;
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const match = /^v(\d+):(.+)$/.exec(part);
    if (!match) throw new CryptoError('ENCRYPTION_KEYS entries must look like v1:<base64>');
    const version = Number(match[1]);
    const key = Buffer.from(match[2] ?? '', 'base64');
    if (key.length !== 32) {
      throw new CryptoError(`Encryption key v${version} must be 32 bytes (got ${key.length})`);
    }
    if (keys.has(version)) throw new CryptoError(`Duplicate encryption key version v${version}`);
    keys.set(version, key);
    currentVersion = Math.max(currentVersion, version);
  }
  if (keys.size === 0) throw new CryptoError('ENCRYPTION_KEYS is empty');
  return { currentVersion, keys };
}

function seal(key: Buffer, aad: string, plaintext: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}

function open(key: Buffer, aad: string, sealed: string): Buffer {
  const parts = sealed.split('.');
  if (parts.length !== 3) throw new CryptoError('Malformed ciphertext');
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64url')) as [Buffer, Buffer, Buffer];
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new CryptoError('Malformed ciphertext');
  try {
    const decipher = createDecipheriv(ALG, key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new CryptoError('Decryption failed (wrong key, wrong context, or tampered data)');
  }
}

export function generateDek(): Buffer {
  return randomBytes(32);
}

export function wrapDek(keyring: Keyring, orgId: string, dek: Buffer): WrappedDek {
  const kek = keyring.keys.get(keyring.currentVersion);
  if (!kek) throw new CryptoError(`Missing current key v${keyring.currentVersion}`);
  return { kekVersion: keyring.currentVersion, wrapped: seal(kek, `dek:${orgId}`, dek) };
}

export function unwrapDek(keyring: Keyring, orgId: string, w: WrappedDek): Buffer {
  const kek = keyring.keys.get(w.kekVersion);
  if (!kek) throw new CryptoError(`Unknown encryption key version v${w.kekVersion}`);
  return open(kek, `dek:${orgId}`, w.wrapped);
}

export function encryptSecret(dek: Buffer, context: string, plaintext: string): string {
  return SECRET_PREFIX + seal(dek, context, Buffer.from(plaintext, 'utf8'));
}

export function decryptSecret(dek: Buffer, context: string, payload: string): string {
  if (!payload.startsWith(SECRET_PREFIX)) throw new CryptoError('Unsupported secret format');
  return open(dek, context, payload.slice(SECRET_PREFIX.length)).toString('utf8');
}
```

`packages/crypto/src/index.ts`:
```ts
export * from './envelope';
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run --project crypto && pnpm typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/crypto
git commit -m "feat(crypto): per-org envelope encryption with versioned KEKs"
```

---

### Task 3: `@agile/db` — schema, RLS, migrations, test database

**Files:**
- Create: `docker-compose.yml`, `docker/postgres/init/01-app-role.sh`
- Create: `packages/db/{package.json,tsconfig.json,vitest.config.ts,drizzle.config.ts}`
- Create: `packages/db/src/schema/{app.ts,index.ts}`, `packages/db/src/{client.ts,migrate.ts,migrate-cli.ts,testing.ts,index.ts}`
- Create (generated + edited): `packages/db/drizzle/*`
- Test: `packages/db/src/rls.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Tables: `orgDataKeys`, `jiraConnections`, `llmConnections`, `auditLog`; enums `jiraDeployment` (`cloud|datacenter`), `jiraAuthType` (`basic|oauth|pat`), `connectionStatus` (`untested|ok|error`), `llmProvider` (`anthropic|openai|google|azure|mistral|openai_compatible`).
  - `createDb(url: string, opts?: { max?: number }): { db: Db; close(): Promise<void> }`
  - `type Db`, `type Tx`
  - `withOrg<T>(db: Db, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T>`
  - `runMigrations(ownerUrl: string): Promise<void>`
  - `isUniqueViolation(e: unknown): boolean`
  - `@agile/db/testing`: `startTestDatabase(): Promise<TestDatabase>` where `TestDatabase = { ownerUrl: string; appUrl: string; stop(): Promise<void> }`.

- [ ] **Step 1: Dev database with a non-owner app role**

`docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: agile
      POSTGRES_PASSWORD: agile_dev_password
      POSTGRES_DB: agile
      APP_DB_PASSWORD: app_user_dev_password
    ports: ["5432:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./docker/postgres/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U agile -d agile"]
      interval: 2s
      retries: 30
volumes:
  pgdata:
```

`docker/postgres/init/01-app-role.sh` (make executable: `chmod +x`):
```sh
#!/bin/sh
# Creates the non-owner role the app connects as, so Postgres row-level security applies to it.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE app_user LOGIN PASSWORD '${APP_DB_PASSWORD}';
  GRANT CONNECT ON DATABASE "${POSTGRES_DB}" TO app_user;
  GRANT USAGE ON SCHEMA public TO app_user;
EOSQL
```

Run: `docker compose up -d postgres` — Expected: container healthy.

- [ ] **Step 2: Package files**

`packages/db/package.json`:
```json
{
  "name": "@agile/db",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./testing": "./src/testing.ts" },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "generate": "drizzle-kit generate",
    "migrate": "tsx src/migrate-cli.ts"
  },
  "dependencies": { "drizzle-orm": "0.45.3", "postgres": "3.4.9" },
  "devDependencies": {
    "@testcontainers/postgresql": "12.2.0",
    "drizzle-kit": "0.31.11",
    "tsx": "^4.20.0"
  }
}
```

`packages/db/tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "include": ["src", "drizzle.config.ts"] }`

`packages/db/vitest.config.ts`:
```ts
import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'db',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
```

`packages/db/drizzle.config.ts`:
```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_OWNER_URL ?? 'postgres://agile:agile_dev_password@localhost:5432/agile',
  },
  strict: true,
  verbose: true,
});
```

- [ ] **Step 3: Schema**

`packages/db/src/schema/app.ts`:
```ts
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Rows are visible/writable only when app.current_org_id (set by withOrg) matches. */
const tenantPolicy = (table: string, orgId: AnyPgColumn) =>
  pgPolicy(`${table}_tenant_isolation`, {
    as: 'permissive',
    for: 'all',
    to: 'public',
    using: sql`${orgId} = current_setting('app.current_org_id', true)`,
    withCheck: sql`${orgId} = current_setting('app.current_org_id', true)`,
  });

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp('updated_at', { withTimezone: true })
  .notNull()
  .defaultNow()
  .$onUpdate(() => new Date());

export const jiraDeployment = pgEnum('jira_deployment', ['cloud', 'datacenter']);
export const jiraAuthType = pgEnum('jira_auth_type', ['basic', 'oauth', 'pat']);
export const connectionStatus = pgEnum('connection_status', ['untested', 'ok', 'error']);
export const llmProvider = pgEnum('llm_provider', [
  'anthropic',
  'openai',
  'google',
  'azure',
  'mistral',
  'openai_compatible',
]);

export const orgDataKeys = pgTable(
  'org_data_keys',
  {
    orgId: text('org_id').primaryKey(),
    kekVersion: integer('kek_version').notNull(),
    wrappedDek: text('wrapped_dek').notNull(),
    createdAt,
  },
  (t) => [tenantPolicy('org_data_keys', t.orgId)],
);

export const jiraConnections = pgTable(
  'jira_connections',
  {
    // App-generated (not defaultRandom) so the secret can be encrypted bound to this id before insert.
    id: uuid('id').primaryKey(),
    orgId: text('org_id').notNull(),
    name: text('name').notNull(),
    deployment: jiraDeployment('deployment').notNull(),
    authType: jiraAuthType('auth_type').notNull(),
    baseUrl: text('base_url').notNull(),
    cloudId: text('cloud_id'),
    accountId: text('account_id'),
    accountName: text('account_name'),
    secret: text('secret').notNull(),
    status: connectionStatus('status').notNull().default('untested'),
    lastError: text('last_error'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex('jira_connections_org_url_uq').on(t.orgId, t.baseUrl),
    tenantPolicy('jira_connections', t.orgId),
  ],
);

export const llmConnections = pgTable(
  'llm_connections',
  {
    id: uuid('id').primaryKey(),
    orgId: text('org_id').notNull(),
    label: text('label').notNull(),
    provider: llmProvider('provider').notNull(),
    model: text('model').notNull(),
    baseUrl: text('base_url'),
    azureResourceName: text('azure_resource_name'),
    keyHint: text('key_hint'),
    secret: text('secret').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    status: connectionStatus('status').notNull().default('untested'),
    lastError: text('last_error'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [
    index('llm_connections_org_idx').on(t.orgId),
    uniqueIndex('llm_connections_one_default_uq').on(t.orgId).where(sql`${t.isDefault}`),
    tenantPolicy('llm_connections', t.orgId),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id').notNull(),
    actorUserId: text('actor_user_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt,
  },
  (t) => [
    index('audit_log_org_created_idx').on(t.orgId, t.createdAt),
    tenantPolicy('audit_log', t.orgId),
  ],
);
```

`packages/db/src/schema/index.ts`:
```ts
export * from './app';
```

- [ ] **Step 4: Client, migrator, test database**

`packages/db/src/client.ts`:
```ts
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export function createDb(url: string, opts: { max?: number } = {}) {
  const client = postgres(url, { max: opts.max ?? 10 });
  const db = drizzle(client, { schema });
  return { db, close: () => client.end() };
}

export type Db = ReturnType<typeof createDb>['db'];
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Runs fn in a transaction scoped to one tenant; RLS hides every other org's rows. */
export function withOrg<T>(db: Db, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!orgId) throw new Error('withOrg requires a non-empty orgId');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/** Postgres unique_violation, whether thrown directly or wrapped by drizzle (DrizzleQueryError.cause). */
export function isUniqueViolation(e: unknown): boolean {
  for (let cur: unknown = e; cur; cur = (cur as { cause?: unknown }).cause) {
    if ((cur as { code?: unknown }).code === '23505') return true;
  }
  return false;
}
```

`packages/db/src/migrate.ts`:
```ts
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

export async function runMigrations(ownerUrl: string): Promise<void> {
  const client = postgres(ownerUrl, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end();
  }
}
```

`packages/db/src/migrate-cli.ts`:
```ts
import { runMigrations } from './migrate';

const url = process.env.DATABASE_OWNER_URL;
if (!url) {
  console.error('DATABASE_OWNER_URL is required to run migrations');
  process.exit(1);
}
await runMigrations(url);
console.log('Migrations applied');
```

`packages/db/src/testing.ts`:
```ts
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { runMigrations } from './migrate';

export interface TestDatabase {
  ownerUrl: string;
  appUrl: string;
  stop(): Promise<void>;
}

const APP_PASSWORD = 'app_user_test_password';

/** Fresh Postgres 17 with the app_user role and all migrations applied. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const ownerUrl = container.getConnectionUri();
  const admin = postgres(ownerUrl, { max: 1 });
  await admin.unsafe(
    `CREATE ROLE app_user LOGIN PASSWORD '${APP_PASSWORD}'; GRANT USAGE ON SCHEMA public TO app_user;`,
  );
  await admin.end();
  await runMigrations(ownerUrl);
  const app = new URL(ownerUrl);
  app.username = 'app_user';
  app.password = APP_PASSWORD;
  return { ownerUrl, appUrl: app.toString(), stop: async () => void (await container.stop()) };
}
```

`packages/db/src/index.ts`:
```ts
export { createDb, isUniqueViolation, withOrg, type Db, type Tx } from './client';
export { runMigrations } from './migrate';
export * from './schema';
```

- [ ] **Step 5: Generate migrations, then add the custom grants migration**

Run:
```bash
pnpm db:generate
pnpm --filter @agile/db exec drizzle-kit generate --custom --name app_role_grants
```
Expected: `packages/db/drizzle/0000_*.sql` (tables, enums, policies, `ENABLE ROW LEVEL SECURITY`) and an empty `0001_app_role_grants.sql`.

Replace the contents of `packages/db/drizzle/0001_app_role_grants.sql` with:
```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON audit_log FROM app_user;
--> statement-breakpoint
ALTER TABLE org_data_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jira_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE llm_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
```

- [ ] **Step 6: Write the RLS tests**

`packages/db/src/rls.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withOrg } from './client';
import { auditLog, jiraConnections } from './schema';
import { startTestDatabase, type TestDatabase } from './testing';

const pgMessage = (e: unknown): string =>
  e instanceof Error ? `${e.message} ${(e.cause as Error | undefined)?.message ?? ''}` : String(e);

const connectionRow = (orgId: string) => ({
  id: randomUUID(),
  orgId,
  name: 'Jira',
  deployment: 'datacenter' as const,
  authType: 'pat' as const,
  baseUrl: `https://jira.${orgId}.example/${randomUUID()}`,
  secret: 's1.x.y.z',
  createdBy: 'user_1',
});

describe('row-level security (as app_user)', () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = createDb(tdb.appUrl, { max: 1 }); // one connection: proves org context doesn't leak
  });
  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('shows each org only its own rows', async () => {
    await withOrg(app.db, 'org_a', (tx) => tx.insert(jiraConnections).values(connectionRow('org_a')));
    await withOrg(app.db, 'org_b', (tx) => tx.insert(jiraConnections).values(connectionRow('org_b')));
    const seenByA = await withOrg(app.db, 'org_a', (tx) => tx.select().from(jiraConnections));
    expect(seenByA.map((r) => r.orgId)).toEqual(['org_a']);
  });

  it('shows nothing outside withOrg, even on a connection that just ran withOrg', async () => {
    await withOrg(app.db, 'org_a', (tx) => tx.select().from(jiraConnections));
    expect(await app.db.select().from(jiraConnections)).toEqual([]);
  });

  it("rejects writing another org's row", async () => {
    await expect(
      withOrg(app.db, 'org_a', (tx) => tx.insert(jiraConnections).values(connectionRow('org_b'))),
    ).rejects.toSatisfy((e: unknown) => /row-level security/.test(pgMessage(e)));
  });

  it('keeps the audit log append-only', async () => {
    await withOrg(app.db, 'org_a', (tx) => tx.insert(auditLog).values({ orgId: 'org_a', action: 'test' }));
    await expect(withOrg(app.db, 'org_a', (tx) => tx.delete(auditLog))).rejects.toSatisfy(
      (e: unknown) => /permission denied/.test(pgMessage(e)),
    );
  });

  it('refuses an empty org id', () => {
    expect(() => withOrg(app.db, '', async () => 1)).toThrow(/non-empty/);
  });
});
```

- [ ] **Step 7: Run tests**

Run: `pnpm vitest run --project db`
Expected: 5 PASS (first run pulls `postgres:17-alpine`; Docker must be running).

- [ ] **Step 8: Apply to the dev database and commit**

Run: `DATABASE_OWNER_URL=postgres://agile:agile_dev_password@localhost:5432/agile pnpm db:migrate`
Expected: `Migrations applied`.

```bash
git add -A
git commit -m "feat(db): tenant schema with forced RLS, app_user grants, and test database helper"
```

---

### Task 4: `@agile/auth` — better-auth with workspaces

**Files:**
- Create: `packages/auth/{package.json,tsconfig.json,vitest.config.ts}`, `packages/auth/src/{server.ts,roles.ts,cli-config.ts,index.ts}`
- Create (generated): `packages/db/src/schema/auth.ts`; Modify: `packages/db/src/schema/index.ts`; new migration in `packages/db/drizzle/`
- Test: `packages/auth/src/auth.test.ts`

**Interfaces:**
- Consumes: `createDb`, `Db`, `startTestDatabase` (Task 3).
- Produces:
  - `createAuth(opts: { db: Db; secret: string; baseURL: string }): Auth`, `type Auth`
  - `getMemberRoles(db: Db, orgId: string, userId: string): Promise<string[]>` (empty if not a member)
  - `canManageConnections(roles: readonly string[]): boolean` (true for `owner` / `admin`)
  - Generated tables in `@agile/db`: `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation` (columns snake_case, ids text).

- [ ] **Step 1: Package files**

`packages/auth/package.json`:
```json
{
  "name": "@agile/auth",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "generate-schema": "auth generate --config src/cli-config.ts --output ../db/src/schema/auth.ts --adapter drizzle --dialect postgresql --yes"
  },
  "dependencies": { "@agile/db": "workspace:*", "better-auth": "1.7.7", "drizzle-orm": "0.45.3" },
  "devDependencies": { "auth": "1.7.7" }
}
```
`tsconfig.json` and `vitest.config.ts` follow the Task 3 pattern (name `auth`, `hookTimeout: 120_000`).

- [ ] **Step 2: Auth config**

`packages/auth/src/server.ts`:
```ts
import { type Db } from '@agile/db';
import * as schema from '@agile/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { organization } from 'better-auth/plugins/organization';

export interface AuthOptions {
  db: Db;
  secret: string;
  baseURL: string;
}

export function createAuth({ db, secret, baseURL }: AuthOptions) {
  return betterAuth({
    baseURL,
    secret,
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    plugins: [organization({ allowUserToCreateOrganization: true }), nextCookies()], // nextCookies last
  });
}

export type Auth = ReturnType<typeof createAuth>;
```

`packages/auth/src/cli-config.ts` (used only by `auth generate`, which reads the options and never connects):
```ts
import { createDb } from '@agile/db';
import { createAuth } from './server';

export const auth = createAuth({
  db: createDb('postgres://unused:unused@localhost:5432/unused').db,
  secret: 'cli-only-secret-not-used-at-runtime-000',
  baseURL: 'http://localhost:3000',
});
```

- [ ] **Step 3: Generate the auth schema and migration**

Run:
```bash
pnpm --filter @agile/auth generate-schema
```
Expected: `packages/db/src/schema/auth.ts` exporting `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`.

Edit `packages/db/src/schema/index.ts`:
```ts
export * from './app';
export * from './auth';
```

Run: `pnpm db:generate`
Expected: `packages/db/drizzle/0002_*.sql` creating the auth tables. Do not edit it — the default privileges from `0001` grant `app_user` access automatically.

- [ ] **Step 4: Roles helper**

`packages/auth/src/roles.ts`:
```ts
import { type Db, member } from '@agile/db';
import { and, eq } from 'drizzle-orm';

/** better-auth stores multiple roles as a comma-separated string. */
export async function getMemberRoles(db: Db, orgId: string, userId: string): Promise<string[]> {
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1);
  return row ? row.role.split(',').map((r) => r.trim()).filter(Boolean) : [];
}

export function canManageConnections(roles: readonly string[]): boolean {
  return roles.includes('owner') || roles.includes('admin');
}
```

`packages/auth/src/index.ts`:
```ts
export { createAuth, type Auth, type AuthOptions } from './server';
export { canManageConnections, getMemberRoles } from './roles';
```

- [ ] **Step 5: Write the integration test**

`packages/auth/src/auth.test.ts`:
```ts
import { createDb } from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canManageConnections, getMemberRoles } from './roles';
import { createAuth, type Auth } from './server';

const cookieHeader = (h: Headers) =>
  new Headers({ cookie: h.getSetCookie().map((c) => c.split(';')[0]).join('; ') });

describe('auth', () => {
  let tdb: TestDatabase;
  let conn: ReturnType<typeof createDb>;
  let auth: Auth;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    conn = createDb(tdb.appUrl, { max: 2 });
    auth = createAuth({ db: conn.db, secret: 'x'.repeat(32), baseURL: 'http://localhost:3000' });
  });
  afterAll(async () => {
    await conn?.close();
    await tdb?.stop();
  });

  it('signs up, creates a workspace, and the session carries it as active org', async () => {
    const { headers } = await auth.api.signUpEmail({
      body: { email: 'pm@example.com', password: 'correct-horse-1', name: 'Pat' },
      returnHeaders: true,
    });
    const h = cookieHeader(headers);
    const org = await auth.api.createOrganization({ headers: h, body: { name: 'Acme', slug: 'acme' } });
    const session = await auth.api.getSession({ headers: h });

    expect(org?.id).toBeTruthy();
    expect(session?.session.activeOrganizationId).toBe(org?.id);

    const roles = await getMemberRoles(conn.db, org?.id ?? '', session?.user.id ?? '');
    expect(roles).toEqual(['owner']);
    expect(canManageConnections(roles)).toBe(true);
  });

  it('returns no roles for a non-member', async () => {
    expect(await getMemberRoles(conn.db, 'org_missing', 'user_missing')).toEqual([]);
    expect(canManageConnections(['member'])).toBe(false);
  });
});
```

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run --project auth && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(auth): better-auth with organizations, generated schema, role helpers"
```

---

### Task 5: `@agile/net` + `@agile/jira` — URL policy, normalisation, connection test

**Files:**
- Create: `packages/net/{package.json,tsconfig.json,vitest.config.ts}`, `packages/net/src/{outbound-url.ts,index.ts}`; Test: `packages/net/src/outbound-url.test.ts`
- Create: `packages/jira/{package.json,tsconfig.json,vitest.config.ts}`, `packages/jira/src/{types.ts,normalize.ts,errors.ts,probe.ts,test-connection.ts,index.ts}`, `packages/jira/src/testing/mock-jira-server.ts`
- Test: `packages/jira/src/normalize.test.ts`, `packages/jira/src/probe.test.ts`, `packages/jira/src/test-connection.test.ts`

**Interfaces:**
- Produces (`@agile/net`):
  - `type Resolver = (hostname: string) => Promise<string[]>`
  - `checkOutboundUrl(raw: string, opts: { allowedPrivateHosts: readonly string[]; resolve?: Resolver }): Promise<{ ok: true; url: URL } | { ok: false; reason: string }>`
- Produces (`@agile/jira`):
  - `type JiraDeployment = 'cloud' | 'datacenter'`
  - `type JiraCredentials = { kind: 'cloud_basic'; baseUrl: string; email: string; apiToken: string } | { kind: 'cloud_oauth'; baseUrl: string; cloudId: string; accessToken: string } | { kind: 'datacenter_pat'; baseUrl: string; token: string }`
  - `type JiraFailureCode = 'invalid_input' | 'blocked_url' | 'unauthorized' | 'forbidden' | 'not_found' | 'not_jira' | 'wrong_deployment' | 'rate_limited' | 'unreachable' | 'unknown'`
  - `type JiraTestResult = { ok: true; deployment: JiraDeployment; version: string | null; account: { id: string; displayName: string } } | { ok: false; code: JiraFailureCode; message: string }`
  - `inferDeployment(url: string): JiraDeployment`
  - `normalizeBaseUrl(raw: string): string` (throws `TypeError` for non-URLs)
  - `normalizeCredentials(c: JiraCredentials): JiraCredentials`
  - `probeJira(c: JiraCredentials, opts?: { atlassianApiBase?: string; timeoutMs?: number }): Promise<JiraTestResult>`
  - `testJiraConnection(c: JiraCredentials, opts: { allowedPrivateHosts: readonly string[]; resolve?: Resolver; atlassianApiBase?: string }): Promise<JiraTestResult>`
  - `@agile/jira/testing`: `startMockJira(opts: { flavor: 'cloud' | 'datacenter'; validAuthorization: string; pathPrefix?: string }): Promise<{ url: string; requests: { path: string; authorization?: string }[]; close(): Promise<void> }>`

- [ ] **Step 1: Package files**

`packages/net/package.json`: Task 1 convention, name `@agile/net`, `"dependencies": { "ipaddr.js": "^2.2.0" }`.

`packages/jira/package.json`:
```json
{
  "name": "@agile/jira",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./testing": "./src/testing/mock-jira-server.ts" },
  "scripts": { "typecheck": "tsc -p tsconfig.json" },
  "dependencies": {
    "@agile/net": "workspace:*",
    "arctic": "3.7.0",
    "jira.js": "6.2.0",
    "jira-js-v5": "npm:jira.js@^5.4.0",
    "zod": "4.6.5"
  }
}
```
`tsconfig.json`/`vitest.config.ts` per convention (names `net`, `jira`).

- [ ] **Step 2: Write failing tests for the outbound URL guard**

`packages/net/src/outbound-url.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { checkOutboundUrl, type Resolver } from './outbound-url';

const resolveTo =
  (...ips: string[]): Resolver =>
  async () =>
    ips;
const opts = (resolve: Resolver, allowedPrivateHosts: string[] = []) => ({ resolve, allowedPrivateHosts });

describe('checkOutboundUrl', () => {
  it('accepts a public https host', async () => {
    const r = await checkOutboundUrl('https://acme.atlassian.net', opts(resolveTo('104.192.141.1')));
    expect(r.ok).toBe(true);
  });

  it.each([
    ['ftp://jira.example.com', /http/],
    ['https://user:pw@jira.example.com', /credentials/],
    ['not a url', /valid URL/],
    ['http://localhost:8080', /private|localhost/],
    ['http://metadata.google.internal', /blocked/],
  ])('rejects %s', async (url, reason) => {
    const r = await checkOutboundUrl(url, opts(resolveTo('8.8.8.8')));
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(reason) });
  });

  it.each(['10.0.0.5', '192.168.1.10', '127.0.0.1', '169.254.169.254', '::1', '::ffff:10.0.0.1', 'fd00::1'])(
    'rejects hosts resolving to %s',
    async (ip) => {
      const r = await checkOutboundUrl('https://jira.corp.example', opts(resolveTo('8.8.8.8', ip)));
      expect(r.ok).toBe(false);
    },
  );

  it('rejects private IP literals', async () => {
    expect((await checkOutboundUrl('http://10.1.2.3/jira', opts(resolveTo()))).ok).toBe(false);
  });

  it('allows private hosts (and their subdomains) on the operator allowlist without DNS', async () => {
    const neverResolve: Resolver = async () => {
      throw new Error('should not resolve');
    };
    const r = await checkOutboundUrl('http://jira.corp.local/jira', opts(neverResolve, ['corp.local']));
    expect(r.ok).toBe(true);
  });

  it('reports unresolvable hosts', async () => {
    const failing: Resolver = async () => {
      throw new Error('ENOTFOUND');
    };
    expect(await checkOutboundUrl('https://nope.example', opts(failing))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/resolve/),
    });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm install && pnpm vitest run --project net`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the guard**

`packages/net/src/outbound-url.ts`:
```ts
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export type Resolver = (hostname: string) => Promise<string[]>;
export type OutboundUrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

const defaultResolver: Resolver = async (host) =>
  (await lookup(host, { all: true })).map((a) => a.address);

const ALWAYS_BLOCKED = new Set(['metadata.google.internal', 'metadata']);

const matchesHost = (host: string, allowed: readonly string[]) =>
  allowed.some((d) => host === d || host.endsWith(`.${d}`));

/**
 * Guards server-side requests to user-supplied URLs (SSRF): only http(s), no embedded
 * credentials, and no private/reserved addresses unless the operator allowlisted the host.
 */
export async function checkOutboundUrl(
  raw: string,
  opts: { allowedPrivateHosts: readonly string[]; resolve?: Resolver },
): Promise<OutboundUrlCheck> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'Not a valid URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'Only http and https URLs are allowed' };
  }
  if (url.username || url.password) return { ok: false, reason: 'URLs must not contain credentials' };

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (ALWAYS_BLOCKED.has(host)) return { ok: false, reason: `Host ${host} is blocked` };
  if (matchesHost(host, opts.allowedPrivateHosts)) return { ok: true, url };
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, reason: 'localhost is a private address; ask your administrator to allow it' };
  }

  let addresses: string[];
  if (ipaddr.isValid(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await (opts.resolve ?? defaultResolver)(host);
    } catch {
      return { ok: false, reason: `Could not resolve ${host}` };
    }
  }
  if (addresses.length === 0) return { ok: false, reason: `Could not resolve ${host}` };

  for (const address of addresses) {
    const range = ipaddr.process(address).range();
    if (range !== 'unicast') {
      return {
        ok: false,
        reason: `${host} points to a private or reserved address (${range}); ask your administrator to allow this host`,
      };
    }
  }
  return { ok: true, url };
}
```

`packages/net/src/index.ts`: `export * from './outbound-url';`

Run: `pnpm vitest run --project net` — Expected: PASS.

- [ ] **Step 5: Write failing tests for normalisation**

`packages/jira/src/normalize.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { inferDeployment, normalizeBaseUrl, normalizeCredentials } from './normalize';

describe('normalizeBaseUrl', () => {
  it.each([
    ['https://acme.atlassian.net/', 'https://acme.atlassian.net'],
    ['  https://acme.atlassian.net/jira/software/projects/X/boards/1?selectedIssue=X-1 ', 'https://acme.atlassian.net'],
    ['https://ACME.atlassian.net/browse/X-1#comment', 'https://acme.atlassian.net'],
    ['https://jira.corp.example/jira/', 'https://jira.corp.example/jira'],
    ['https://jira.corp.example/jira/browse/ABC-12', 'https://jira.corp.example/jira'],
    ['https://jira.corp.example/secure/Dashboard.jspa', 'https://jira.corp.example'],
    ['http://jira.corp.local:8080/projects/ABC/issues', 'http://jira.corp.local:8080'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeBaseUrl(raw)).toBe(expected);
  });

  it('throws on garbage', () => {
    expect(() => normalizeBaseUrl('jira')).toThrow(TypeError);
  });
});

describe('inferDeployment', () => {
  it('detects Atlassian Cloud hosts', () => {
    expect(inferDeployment('https://acme.atlassian.net')).toBe('cloud');
    expect(inferDeployment('https://jira.corp.example')).toBe('datacenter');
  });
});

describe('normalizeCredentials', () => {
  it('trims pasted whitespace and normalises the URL', () => {
    expect(
      normalizeCredentials({
        kind: 'cloud_basic',
        baseUrl: 'https://acme.atlassian.net/ ',
        email: ' pm@acme.com\n',
        apiToken: '\tATATT3xFfGF0abc\n',
      }),
    ).toEqual({
      kind: 'cloud_basic',
      baseUrl: 'https://acme.atlassian.net',
      email: 'pm@acme.com',
      apiToken: 'ATATT3xFfGF0abc',
    });
    expect(
      normalizeCredentials({ kind: 'datacenter_pat', baseUrl: 'https://j.example/jira/', token: ' t \n' }),
    ).toEqual({ kind: 'datacenter_pat', baseUrl: 'https://j.example/jira', token: 't' });
  });
});
```

- [ ] **Step 6: Implement types and normalisation**

`packages/jira/src/types.ts`:
```ts
export type JiraDeployment = 'cloud' | 'datacenter';

export type JiraCredentials =
  | { kind: 'cloud_basic'; baseUrl: string; email: string; apiToken: string }
  | { kind: 'cloud_oauth'; baseUrl: string; cloudId: string; accessToken: string }
  | { kind: 'datacenter_pat'; baseUrl: string; token: string };

export type JiraFailureCode =
  | 'invalid_input'
  | 'blocked_url'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'not_jira'
  | 'wrong_deployment'
  | 'rate_limited'
  | 'unreachable'
  | 'unknown';

export type JiraFailure = { ok: false; code: JiraFailureCode; message: string };

export type JiraTestResult =
  | {
      ok: true;
      deployment: JiraDeployment;
      version: string | null;
      account: { id: string; displayName: string };
    }
  | JiraFailure;
```

`packages/jira/src/normalize.ts`:
```ts
import type { JiraCredentials, JiraDeployment } from './types';

const CLOUD_HOST = /\.(atlassian\.net|jira\.com)$/i;
// Path segments that start an in-app page rather than the base URL (DC keeps any context path before them).
const APP_PATH = /\/(browse|secure|projects|issues|plugins|jira\/software|rest|login\.jsp)(\/.*)?$/i;

export function inferDeployment(url: string): JiraDeployment {
  try {
    return CLOUD_HOST.test(new URL(url.trim()).hostname) ? 'cloud' : 'datacenter';
  } catch {
    return 'datacenter';
  }
}

export function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw.trim()); // throws TypeError on invalid input
  if (CLOUD_HOST.test(url.hostname)) return url.origin;
  const path = url.pathname.replace(APP_PATH, '').replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

export function normalizeCredentials(c: JiraCredentials): JiraCredentials {
  const baseUrl = normalizeBaseUrl(c.baseUrl);
  switch (c.kind) {
    case 'cloud_basic':
      return { kind: c.kind, baseUrl, email: c.email.trim(), apiToken: c.apiToken.trim() };
    case 'cloud_oauth':
      return { kind: c.kind, baseUrl, cloudId: c.cloudId.trim(), accessToken: c.accessToken.trim() };
    case 'datacenter_pat':
      return { kind: c.kind, baseUrl, token: c.token.trim() };
  }
}
```

Run: `pnpm vitest run --project jira src/normalize.test.ts` — Expected: PASS.

- [ ] **Step 7: Mock Jira server (shared by unit and e2e tests)**

`packages/jira/src/testing/mock-jira-server.ts`:
```ts
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockJiraOptions {
  flavor: 'cloud' | 'datacenter';
  /** Exact Authorization header value that is accepted, e.g. "Bearer good-pat". */
  validAuthorization: string;
  /** e.g. "/jira" (DC context path) or "/ex/jira/cloud-123" (OAuth gateway). */
  pathPrefix?: string;
}

export interface MockJira {
  url: string;
  requests: { path: string; authorization?: string }[];
  close(): Promise<void>;
}

const CLOUD_MYSELF = {
  self: 'https://acme.atlassian.net/rest/api/3/user?accountId=acc-1',
  accountId: 'acc-1',
  accountType: 'atlassian',
  emailAddress: 'pm@acme.com',
  displayName: 'Pat Cloud',
  active: true,
  timeZone: 'Europe/Paris',
  locale: 'en_US',
  avatarUrls: {},
};
const CLOUD_SERVER_INFO = {
  baseUrl: 'https://acme.atlassian.net',
  version: '1001.0.0-SNAPSHOT',
  versionNumbers: [1001, 0, 0],
  deploymentType: 'Cloud',
  buildNumber: 100,
  buildDate: '2026-09-30T00:00:00.000+0000',
  serverTime: '2026-10-03T00:00:00.000+0000',
  scmInfo: 'abc',
  serverTitle: 'Jira',
  defaultLocale: { locale: 'en_US' },
};
const DC_MYSELF = { self: 'x', key: 'JIRAUSER1', name: 'pat', displayName: 'Pat DC', active: true };
const DC_SERVER_INFO = {
  baseUrl: 'https://jira.corp.example',
  version: '10.3.0',
  versionNumbers: [10, 3, 0],
  deploymentType: 'Server',
  buildNumber: 10030000,
  serverTitle: 'Corp Jira',
};

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export async function startMockJira(opts: MockJiraOptions): Promise<MockJira> {
  const api = opts.flavor === 'cloud' ? '3' : '2';
  const prefix = opts.pathPrefix ?? '';
  const requests: MockJira['requests'] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    requests.push({ path, authorization: req.headers.authorization });
    if (req.headers.authorization !== opts.validAuthorization) {
      return json(res, 401, { errorMessages: ['You are not authenticated.'] });
    }
    if (path === `${prefix}/rest/api/${api}/myself`) {
      return json(res, 200, opts.flavor === 'cloud' ? CLOUD_MYSELF : DC_MYSELF);
    }
    if (path === `${prefix}/rest/api/${api}/serverInfo`) {
      return json(res, 200, opts.flavor === 'cloud' ? CLOUD_SERVER_INFO : DC_SERVER_INFO);
    }
    json(res, 404, { errorMessages: ['Not found'] });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${prefix}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
```

- [ ] **Step 8: Write failing probe tests**

`packages/jira/src/probe.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { probeJira } from './probe';
import { type MockJira, startMockJira } from './testing/mock-jira-server';

const basic = (email: string, token: string) =>
  `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;

describe('probeJira', () => {
  let mock: MockJira | undefined;
  afterEach(async () => {
    await mock?.close();
    mock = undefined;
  });

  it('accepts valid Cloud basic credentials (REST v3)', async () => {
    mock = await startMockJira({ flavor: 'cloud', validAuthorization: basic('pm@acme.com', 'tok') });
    const r = await probeJira({ kind: 'cloud_basic', baseUrl: mock.url, email: 'pm@acme.com', apiToken: 'tok' });
    expect(r).toEqual({
      ok: true,
      deployment: 'cloud',
      version: '1001.0.0-SNAPSHOT',
      account: { id: 'acc-1', displayName: 'Pat Cloud' },
    });
  });

  it('maps a rejected Cloud token to unauthorized', async () => {
    mock = await startMockJira({ flavor: 'cloud', validAuthorization: basic('pm@acme.com', 'tok') });
    const r = await probeJira({ kind: 'cloud_basic', baseUrl: mock.url, email: 'pm@acme.com', apiToken: 'bad' });
    expect(r).toMatchObject({ ok: false, code: 'unauthorized' });
  });

  it('uses the OAuth gateway with the cloud id', async () => {
    mock = await startMockJira({
      flavor: 'cloud',
      validAuthorization: 'Bearer access-1',
      pathPrefix: '/ex/jira/cloud-123',
    });
    const gateway = new URL(mock.url).origin;
    const r = await probeJira(
      { kind: 'cloud_oauth', baseUrl: 'https://acme.atlassian.net', cloudId: 'cloud-123', accessToken: 'access-1' },
      { atlassianApiBase: gateway },
    );
    expect(r).toMatchObject({ ok: true, deployment: 'cloud' });
  });

  it('accepts a Data Center PAT (REST v2, bearer) under a context path', async () => {
    mock = await startMockJira({ flavor: 'datacenter', validAuthorization: 'Bearer good-pat', pathPrefix: '/jira' });
    const r = await probeJira({ kind: 'datacenter_pat', baseUrl: mock.url, token: 'good-pat' });
    expect(r).toEqual({
      ok: true,
      deployment: 'datacenter',
      version: '10.3.0',
      account: { id: 'JIRAUSER1', displayName: 'Pat DC' },
    });
    expect(mock.requests.every((req) => req.path.startsWith('/jira/rest/api/2/'))).toBe(true);
  });

  it('maps a rejected PAT to unauthorized', async () => {
    mock = await startMockJira({ flavor: 'datacenter', validAuthorization: 'Bearer good-pat' });
    expect(await probeJira({ kind: 'datacenter_pat', baseUrl: mock.url, token: 'nope' })).toMatchObject({
      ok: false,
      code: 'unauthorized',
    });
  });

  it('flags a Cloud site entered as Data Center', async () => {
    mock = await startMockJira({ flavor: 'cloud', validAuthorization: 'Bearer good-pat' });
    // DC client calls /rest/api/2 — the cloud mock only serves v3, so it is not recognised as Jira DC.
    const r = await probeJira({ kind: 'datacenter_pat', baseUrl: mock.url, token: 'good-pat' });
    expect(r.ok).toBe(false);
  });

  it('maps a closed port to unreachable', async () => {
    const r = await probeJira(
      { kind: 'datacenter_pat', baseUrl: 'http://127.0.0.1:9', token: 't' },
      { timeoutMs: 3_000 },
    );
    expect(r).toMatchObject({ ok: false, code: 'unreachable' });
  });
});
```

- [ ] **Step 9: Run to verify failure**

Run: `pnpm vitest run --project jira src/probe.test.ts`
Expected: FAIL — `Cannot find module './probe'`.

- [ ] **Step 10: Implement error mapping and probe**

`packages/jira/src/errors.ts`:
```ts
import { isApiError, isNetworkError } from 'jira.js';
import type { JiraFailure } from './types';

const NETWORK_CODES =
  /^(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ERR_NETWORK|UND_ERR_\w+)$/;

const readField = (e: unknown, key: string): unknown =>
  typeof e === 'object' && e !== null ? (e as Record<string, unknown>)[key] : undefined;

/** Maps jira.js v6 (fetch) and v5 (axios) errors to stable codes. Never echoes raw error text. */
export function mapJiraError(e: unknown): JiraFailure {
  const status = isApiError(e) ? e.status : readField(e, 'status') ?? readField(readField(e, 'response'), 'status');
  if (status === 401) return { ok: false, code: 'unauthorized', message: 'Jira rejected these credentials.' };
  if (status === 403)
    return { ok: false, code: 'forbidden', message: 'Jira refused access (invalid token or missing permission).' };
  if (status === 404) return { ok: false, code: 'not_jira', message: 'No Jira REST API found at this URL.' };
  if (status === 429) return { ok: false, code: 'rate_limited', message: 'Jira is rate limiting requests. Try again shortly.' };

  const code = readField(e, 'code') ?? readField(readField(e, 'cause'), 'code');
  if (isNetworkError(e) || (typeof code === 'string' && NETWORK_CODES.test(code))) {
    return { ok: false, code: 'unreachable', message: 'Could not reach this Jira server.' };
  }
  const name = e instanceof Error ? e.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { ok: false, code: 'unreachable', message: 'Jira did not answer in time.' };
  }
  if (name === 'SchemaMismatchError' || name === 'SyntaxError') {
    return { ok: false, code: 'not_jira', message: 'This URL did not answer like Jira.' };
  }
  if (name === 'ZodError') return { ok: false, code: 'invalid_input', message: 'Some connection details are invalid.' };
  return { ok: false, code: 'unknown', message: 'Unexpected error while contacting Jira.' };
}
```

`packages/jira/src/probe.ts`:
```ts
import { createCloudClient } from 'jira.js';
import { Version2Client } from 'jira-js-v5';
import { mapJiraError } from './errors';
import type { JiraCredentials, JiraTestResult } from './types';

export interface ProbeOptions {
  /** Atlassian API gateway origin; overridable for tests. */
  atlassianApiBase?: string;
  timeoutMs?: number;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), ms),
    ),
  ]);

async function probeCloud(c: Exclude<JiraCredentials, { kind: 'datacenter_pat' }>, opts: ProbeOptions) {
  const client =
    c.kind === 'cloud_basic'
      ? createCloudClient({ host: c.baseUrl, auth: { type: 'basic', email: c.email, apiToken: c.apiToken } })
      : createCloudClient({
          host: `${opts.atlassianApiBase ?? 'https://api.atlassian.com'}/ex/jira/${c.cloudId}`,
          auth: { type: 'bearer', token: c.accessToken },
        });
  const [me, info] = await Promise.all([client.myself.getCurrentUser(), client.serverInfo.getServerInfo()]);
  if (info.deploymentType !== 'Cloud') {
    return {
      ok: false,
      code: 'wrong_deployment',
      message: 'This is a Jira Server/Data Center site. Use a personal access token instead.',
    } as const;
  }
  return {
    ok: true,
    deployment: 'cloud',
    version: info.version ?? null,
    account: { id: me.accountId ?? '', displayName: me.displayName ?? '' },
  } as const;
}

async function probeDataCenter(c: Extract<JiraCredentials, { kind: 'datacenter_pat' }>) {
  // jira.js v6 only speaks REST v3 (Cloud); DC uses v5's Version2Client. A PAT is sent as a bearer token.
  const client = new Version2Client({ host: c.baseUrl, authentication: { oauth2: { accessToken: c.token } } });
  const [me, info] = await Promise.all([client.myself.getCurrentUser(), client.serverInfo.getServerInfo()]);
  if (info.deploymentType === 'Cloud') {
    return {
      ok: false,
      code: 'wrong_deployment',
      message: 'This is a Jira Cloud site. Use "Connect with Atlassian" or an API token.',
    } as const;
  }
  const dcUser = me as { key?: string; name?: string; displayName?: string };
  return {
    ok: true,
    deployment: 'datacenter',
    version: info.version ?? null,
    account: { id: dcUser.key ?? dcUser.name ?? '', displayName: dcUser.displayName ?? '' },
  } as const;
}

/** Verifies credentials against Jira itself. No URL policy — callers use testJiraConnection. */
export async function probeJira(c: JiraCredentials, opts: ProbeOptions = {}): Promise<JiraTestResult> {
  try {
    const run = c.kind === 'datacenter_pat' ? probeDataCenter(c) : probeCloud(c, opts);
    return await withTimeout(run, opts.timeoutMs ?? 15_000);
  } catch (e) {
    return mapJiraError(e);
  }
}
```

- [ ] **Step 11: Run probe tests**

Run: `pnpm vitest run --project jira src/probe.test.ts`
Expected: PASS. If jira.js v6 throws `SchemaMismatchError` on a mock response, add the field its error message names to `CLOUD_MYSELF`/`CLOUD_SERVER_INFO` in the mock (the mock must look like real Jira), not to the probe.

- [ ] **Step 12: Write failing tests for the policy wrapper**

`packages/jira/src/test-connection.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { testJiraConnection } from './test-connection';
import { startMockJira } from './testing/mock-jira-server';

const publicDns = async () => ['104.192.141.1'];

describe('testJiraConnection', () => {
  it('blocks private Jira URLs unless allowlisted', async () => {
    const r = await testJiraConnection(
      { kind: 'datacenter_pat', baseUrl: 'http://127.0.0.1:8080', token: 't' },
      { allowedPrivateHosts: [] },
    );
    expect(r).toMatchObject({ ok: false, code: 'blocked_url' });
  });

  it('requires https for Jira Cloud', async () => {
    const r = await testJiraConnection(
      { kind: 'cloud_basic', baseUrl: 'http://acme.atlassian.net', email: 'a@b.co', apiToken: 't' },
      { allowedPrivateHosts: [], resolve: publicDns },
    );
    expect(r).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('rejects input that is not a URL', async () => {
    const r = await testJiraConnection(
      { kind: 'datacenter_pat', baseUrl: 'jira', token: 't' },
      { allowedPrivateHosts: [] },
    );
    expect(r).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('probes an allowlisted private DC server with trimmed credentials', async () => {
    const mock = await startMockJira({ flavor: 'datacenter', validAuthorization: 'Bearer good-pat' });
    try {
      const r = await testJiraConnection(
        { kind: 'datacenter_pat', baseUrl: `${mock.url}/browse/ABC-1`, token: '  good-pat\n' },
        { allowedPrivateHosts: ['127.0.0.1'] },
      );
      expect(r).toMatchObject({ ok: true, deployment: 'datacenter' });
    } finally {
      await mock.close();
    }
  });
});
```

- [ ] **Step 13: Implement**

`packages/jira/src/test-connection.ts`:
```ts
import { checkOutboundUrl, type Resolver } from '@agile/net';
import { normalizeCredentials } from './normalize';
import { probeJira } from './probe';
import type { JiraCredentials, JiraTestResult } from './types';

export interface TestConnectionOptions {
  allowedPrivateHosts: readonly string[];
  resolve?: Resolver;
  atlassianApiBase?: string;
}

/** Normalises input, applies the outbound URL policy, then verifies the credentials with Jira. */
export async function testJiraConnection(
  input: JiraCredentials,
  opts: TestConnectionOptions,
): Promise<JiraTestResult> {
  let creds: JiraCredentials;
  try {
    creds = normalizeCredentials(input);
  } catch {
    return { ok: false, code: 'invalid_input', message: 'Enter the full Jira URL, e.g. https://jira.example.com' };
  }
  if (creds.kind !== 'datacenter_pat' && !creds.baseUrl.startsWith('https://')) {
    return { ok: false, code: 'invalid_input', message: 'Jira Cloud URLs must use https.' };
  }
  if (creds.kind !== 'cloud_oauth') {
    const check = await checkOutboundUrl(creds.baseUrl, opts);
    if (!check.ok) return { ok: false, code: 'blocked_url', message: check.reason };
  }
  return probeJira(creds, { atlassianApiBase: opts.atlassianApiBase });
}
```

`packages/jira/src/index.ts`:
```ts
export { mapJiraError } from './errors';
export { inferDeployment, normalizeBaseUrl, normalizeCredentials } from './normalize';
export { probeJira, type ProbeOptions } from './probe';
export { testJiraConnection, type TestConnectionOptions } from './test-connection';
export type { JiraCredentials, JiraDeployment, JiraFailure, JiraFailureCode, JiraTestResult } from './types';
```

- [ ] **Step 14: Run all jira/net tests and commit**

Run: `pnpm vitest run --project jira --project net && pnpm typecheck && pnpm lint`
Expected: PASS.

```bash
git add -A
git commit -m "feat(jira): outbound URL guard, URL normalisation, Cloud/DC connection probe"
```

---

### Task 6: `@agile/llm` — BYOK model factory and tool-calling probe

**Files:**
- Create: `packages/llm/{package.json,tsconfig.json,vitest.config.ts}`, `packages/llm/src/{providers.ts,probe.ts,index.ts}`, `packages/llm/src/testing/mock-openai-server.ts`
- Test: `packages/llm/src/providers.test.ts`, `packages/llm/src/probe.test.ts`

**Interfaces:**
- Produces:
  - `const LLM_PROVIDERS = ['anthropic','openai','google','azure','mistral','openai_compatible'] as const`, `type LlmProvider`
  - `type LlmConfig = { provider: 'anthropic' | 'openai' | 'google' | 'mistral'; model: string; apiKey: string } | { provider: 'azure'; model: string; apiKey: string; resourceName: string } | { provider: 'openai_compatible'; model: string; baseUrl: string; apiKey?: string }`
  - `createLanguageModel(cfg: LlmConfig): LanguageModel`
  - `type ProbeFailureCode = 'unauthorized' | 'forbidden' | 'model_not_found' | 'rate_limited' | 'no_tool_calling' | 'unreachable' | 'provider_error'`
  - `type LlmProbeResult = { ok: true; latencyMs: number } | { ok: false; code: ProbeFailureCode; message: string }`
  - `probeModel(model: LanguageModel, opts?: { timeoutMs?: number }): Promise<LlmProbeResult>`
  - `@agile/llm/testing`: `startMockOpenAI(opts: { validKey: string }): Promise<{ baseUrl: string; close(): Promise<void> }>` (baseUrl ends with `/v1`)

- [ ] **Step 1: Package file**

`packages/llm/package.json`:
```json
{
  "name": "@agile/llm",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./testing": "./src/testing/mock-openai-server.ts" },
  "scripts": { "typecheck": "tsc -p tsconfig.json" },
  "dependencies": {
    "@ai-sdk/anthropic": "4.0.71",
    "@ai-sdk/azure": "4.0.90",
    "@ai-sdk/google": "4.0.87",
    "@ai-sdk/mistral": "4.0.56",
    "@ai-sdk/openai": "4.0.83",
    "@ai-sdk/openai-compatible": "3.0.62",
    "ai": "7.0.127",
    "zod": "4.6.5"
  }
}
```

- [ ] **Step 2: Write failing tests**

`packages/llm/src/providers.test.ts`:
```ts
import type { LanguageModel } from 'ai';
import { describe, expect, it } from 'vitest';
import { createLanguageModel, type LlmConfig } from './providers';

const info = (m: LanguageModel) => m as unknown as { provider: string; modelId: string };

describe('createLanguageModel', () => {
  it.each<[LlmConfig, RegExp]>([
    [{ provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'k' }, /anthropic/],
    [{ provider: 'openai', model: 'some-model', apiKey: 'k' }, /openai/],
    [{ provider: 'google', model: 'some-model', apiKey: 'k' }, /google/],
    [{ provider: 'mistral', model: 'some-model', apiKey: 'k' }, /mistral/],
    [{ provider: 'azure', model: 'my-deployment', apiKey: 'k', resourceName: 'res' }, /azure/],
    [{ provider: 'openai_compatible', model: 'llama3.1', baseUrl: 'http://ollama:11434/v1' }, /openai_compatible/],
  ])('builds %o', (cfg, provider) => {
    const m = info(createLanguageModel(cfg));
    expect(m.provider).toMatch(provider);
    expect(m.modelId).toBe(cfg.model);
  });
});
```

`packages/llm/src/probe.test.ts`:
```ts
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { probeModel } from './probe';
import { createLanguageModel } from './providers';
import { startMockOpenAI } from './testing/mock-openai-server';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const toolCallingModel = () =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'report_status', input: '{"status":"ok"}' }],
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage,
      warnings: [],
    }),
  });

const failingModel = (error: unknown) =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw error;
    },
  });

const apiError = (statusCode: number, responseBody = '') =>
  new APICallError({ message: `HTTP ${statusCode}`, url: 'https://provider.test', requestBodyValues: {}, statusCode, responseBody, isRetryable: false });

describe('probeModel', () => {
  it('succeeds when the model calls the tool', async () => {
    expect(await probeModel(toolCallingModel())).toMatchObject({ ok: true });
  });

  it('flags models that answer without calling tools', async () => {
    const textOnly = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage,
        warnings: [],
      }),
    });
    expect(await probeModel(textOnly)).toMatchObject({ ok: false, code: 'no_tool_calling' });
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'model_not_found'],
    [429, 'rate_limited'],
    [500, 'provider_error'],
  ])('maps HTTP %i to %s', async (status, code) => {
    expect(await probeModel(failingModel(apiError(status)))).toMatchObject({ ok: false, code });
  });

  it('maps a 400 about tools to no_tool_calling', async () => {
    const e = apiError(400, '{"error":"registry.ollama.ai/library/gemma does not support tools"}');
    expect(await probeModel(failingModel(e))).toMatchObject({ ok: false, code: 'no_tool_calling' });
  });

  it('maps network failures to unreachable', async () => {
    expect(await probeModel(failingModel(new TypeError('fetch failed')))).toMatchObject({
      ok: false,
      code: 'unreachable',
    });
  });

  it('never includes the provider response body in the message', async () => {
    const r = await probeModel(failingModel(apiError(500, 'internal secret-ish detail')));
    expect(r.ok === false && r.message).not.toContain('secret-ish');
  });

  it('works end-to-end against an OpenAI-compatible server', async () => {
    const mock = await startMockOpenAI({ validKey: 'good-key' });
    try {
      const good = createLanguageModel({ provider: 'openai_compatible', model: 'mock', baseUrl: mock.baseUrl, apiKey: 'good-key' });
      const bad = createLanguageModel({ provider: 'openai_compatible', model: 'mock', baseUrl: mock.baseUrl, apiKey: 'bad' });
      expect(await probeModel(good)).toMatchObject({ ok: true });
      expect(await probeModel(bad)).toMatchObject({ ok: false, code: 'unauthorized' });
    } finally {
      await mock.close();
    }
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm install && pnpm vitest run --project llm`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

`packages/llm/src/providers.ts`:
```ts
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

export const LLM_PROVIDERS = ['anthropic', 'openai', 'google', 'azure', 'mistral', 'openai_compatible'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export type LlmConfig =
  | { provider: 'anthropic' | 'openai' | 'google' | 'mistral'; model: string; apiKey: string }
  | { provider: 'azure'; model: string; apiKey: string; resourceName: string }
  | { provider: 'openai_compatible'; model: string; baseUrl: string; apiKey?: string };

/** Builds a model from a tenant's own key at call time (keys are never read from process.env). */
export function createLanguageModel(cfg: LlmConfig): LanguageModel {
  switch (cfg.provider) {
    case 'anthropic':
      return createAnthropic({ apiKey: cfg.apiKey })(cfg.model);
    case 'openai':
      return createOpenAI({ apiKey: cfg.apiKey })(cfg.model);
    case 'google':
      return createGoogleGenerativeAI({ apiKey: cfg.apiKey })(cfg.model);
    case 'mistral':
      return createMistral({ apiKey: cfg.apiKey })(cfg.model);
    case 'azure':
      return createAzure({ apiKey: cfg.apiKey, resourceName: cfg.resourceName })(cfg.model);
    case 'openai_compatible':
      return createOpenAICompatible({
        name: 'openai_compatible',
        baseURL: cfg.baseUrl,
        apiKey: cfg.apiKey || 'not-needed',
      })(cfg.model);
  }
}
```

`packages/llm/src/probe.ts`:
```ts
import { APICallError, generateText, type LanguageModel, RetryError, stepCountIs, tool } from 'ai';
import { z } from 'zod';

export type ProbeFailureCode =
  | 'unauthorized'
  | 'forbidden'
  | 'model_not_found'
  | 'rate_limited'
  | 'no_tool_calling'
  | 'unreachable'
  | 'provider_error';

export type LlmProbeResult =
  | { ok: true; latencyMs: number }
  | { ok: false; code: ProbeFailureCode; message: string };

const fail = (code: ProbeFailureCode, message: string): LlmProbeResult => ({ ok: false, code, message });

function mapLlmError(e: unknown): LlmProbeResult {
  const err = RetryError.isInstance(e) ? e.lastError : e;
  if (APICallError.isInstance(err)) {
    switch (err.statusCode) {
      case 401:
        return fail('unauthorized', 'The provider rejected this API key.');
      case 403:
        return fail('forbidden', 'This key is not allowed to use this model.');
      case 404:
        return fail('model_not_found', 'The provider does not know this model (or deployment) name.');
      case 429:
        return fail('rate_limited', 'The provider is rate limiting this key, or it has no credit left.');
      case 400:
        if (/tool|function/i.test(err.responseBody ?? '')) {
          return fail('no_tool_calling', 'This model does not support tool calling, which the agent needs.');
        }
        return fail('provider_error', 'The provider rejected the request (HTTP 400).');
      case undefined:
        return fail('unreachable', 'Could not reach the provider.');
      default:
        return fail('provider_error', `The provider returned HTTP ${err.statusCode}.`);
    }
  }
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return fail('unreachable', 'The provider did not answer in time.');
  }
  if (err instanceof TypeError) return fail('unreachable', 'Could not reach the provider.');
  return fail('provider_error', 'Unexpected error from the provider.');
}

/** Cheap check that a key works AND the model can call tools (the agent depends on it). */
export async function probeModel(
  model: LanguageModel,
  opts: { timeoutMs?: number } = {},
): Promise<LlmProbeResult> {
  const started = performance.now();
  try {
    const result = await generateText({
      model,
      tools: {
        report_status: tool({
          description: 'Report that the connection works.',
          inputSchema: z.object({ status: z.literal('ok') }),
          execute: async ({ status }) => status,
        }),
      },
      toolChoice: 'required',
      stopWhen: stepCountIs(1),
      prompt: 'Call the report_status tool with status "ok".',
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    const called = result.steps.some((s) => s.toolCalls.some((c) => c.toolName === 'report_status'));
    return called
      ? { ok: true, latencyMs: Math.round(performance.now() - started) }
      : fail('no_tool_calling', 'The model answered but did not call tools, which the agent needs.');
  } catch (e) {
    return mapLlmError(e);
  }
}
```

`packages/llm/src/testing/mock-openai-server.ts`:
```ts
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Minimal OpenAI-compatible chat endpoint that always calls the requested tool. */
export async function startMockOpenAI(opts: { validKey: string }) {
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
      return send(404, { error: { message: 'not found' } });
    }
    if (req.headers.authorization !== `Bearer ${opts.validKey}`) {
      return send(401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } });
    }
    req.resume();
    req.on('end', () =>
      send(200, {
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: 1_760_000_000,
        model: 'mock',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'report_status', arguments: '{"status":"ok"}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
```

`packages/llm/src/index.ts`:
```ts
export { probeModel, type LlmProbeResult, type ProbeFailureCode } from './probe';
export { createLanguageModel, LLM_PROVIDERS, type LlmConfig, type LlmProvider } from './providers';
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run --project llm && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(llm): BYOK model factory for six providers and tool-calling probe"
```

---

### Task 7: `@agile/connections` — vault, audit, and Jira connection service

**Files:**
- Create: `packages/connections/{package.json,tsconfig.json,vitest.config.ts}`, `packages/connections/src/{actor.ts,errors.ts,vault.ts,audit.ts,jira-connections.ts,index.ts}`
- Test: `packages/connections/src/test-helpers.ts`, `packages/connections/src/jira-connections.test.ts`

**Interfaces:**
- Consumes: `Db`, `withOrg`, `isUniqueViolation`, tables (Task 3); `Keyring`, `generateDek`, `wrapDek`, `unwrapDek`, `encryptSecret`, `decryptSecret` (Task 2); `canManageConnections` (Task 4); `testJiraConnection`, `JiraCredentials`, `JiraTestResult`, `JiraFailureCode`, `normalizeCredentials` (Task 5); `Resolver` (Task 5).
- Produces:
  - `interface Actor { orgId: string; userId: string; roles: readonly string[] }`
  - `class ForbiddenError extends Error`
  - `interface ConnectionDeps { db: Db; keyring: Keyring; allowedPrivateHosts: readonly string[]; resolve?: Resolver; testJira?: typeof testJiraConnection; atlassianApiBase?: string }`
  - `getOrgDek(tx: Tx, keyring: Keyring, orgId: string): Promise<Buffer>`
  - `type AuditAction = 'jira_connection.created' | 'jira_connection.retested' | 'jira_connection.deleted' | 'jira_connection.token_refreshed' | 'llm_connection.created' | 'llm_connection.retested' | 'llm_connection.deleted' | 'llm_connection.default_changed'`
  - `recordAudit(tx: Tx, entry: { orgId: string; actorUserId: string | null; action: AuditAction; targetType: string; targetId: string; metadata?: Record<string, unknown> }): Promise<void>`
  - `interface StoredJiraSecret { credentials: JiraCredentials; oauth?: { refreshToken: string; expiresAt: string } }`
  - `interface JiraConnectionView { id: string; name: string; deployment: 'cloud' | 'datacenter'; authType: 'basic' | 'oauth' | 'pat'; baseUrl: string; accountName: string | null; status: 'untested' | 'ok' | 'error'; lastError: string | null; lastCheckedAt: Date | null; createdAt: Date }`
  - `type ServiceFailure = { ok: false; code: JiraFailureCode | 'duplicate' | 'not_found'; message: string }`
  - `createJiraConnection(deps, actor, input: { name: string; credentials: JiraCredentials; oauth?: StoredJiraSecret['oauth'] }): Promise<{ ok: true; connection: JiraConnectionView } | ServiceFailure>`
  - `listJiraConnections(deps, orgId: string): Promise<JiraConnectionView[]>`
  - `retestJiraConnection(deps, actor, id: string): Promise<{ ok: true; connection: JiraConnectionView } | ServiceFailure>`
  - `deleteJiraConnection(deps, actor, id: string): Promise<{ ok: true } | ServiceFailure>`
  - `loadJiraSecret(deps, orgId: string, id: string): Promise<StoredJiraSecret | null>`

- [ ] **Step 1: Package file**

`packages/connections/package.json`: Task 1 convention, name `@agile/connections`; dependencies `@agile/auth`, `@agile/crypto`, `@agile/db`, `@agile/jira`, `@agile/llm`, `@agile/net` (all `workspace:*`), `drizzle-orm: 0.45.3`, `arctic: 3.7.0`; devDependency `@testcontainers/postgresql: 12.2.0`. Vitest config with `hookTimeout: 120_000`.

- [ ] **Step 2: Small building blocks**

`packages/connections/src/actor.ts`:
```ts
import { canManageConnections } from '@agile/auth';
import { ForbiddenError } from './errors';

export interface Actor {
  orgId: string;
  userId: string;
  roles: readonly string[];
}

export function assertCanManage(actor: Actor): void {
  if (!canManageConnections(actor.roles)) {
    throw new ForbiddenError('Only workspace owners and admins can manage connections');
  }
}
```

`packages/connections/src/errors.ts`:
```ts
export class ForbiddenError extends Error {
  override name = 'ForbiddenError';
}
```

`packages/connections/src/vault.ts`:
```ts
import { type Keyring, generateDek, unwrapDek, wrapDek } from '@agile/crypto';
import { orgDataKeys, type Tx } from '@agile/db';
import { eq } from 'drizzle-orm';

/** Returns the org's data-encryption key, creating it on first use (safe under concurrency). */
export async function getOrgDek(tx: Tx, keyring: Keyring, orgId: string): Promise<Buffer> {
  const read = () => tx.select().from(orgDataKeys).where(eq(orgDataKeys.orgId, orgId)).limit(1);
  let [row] = await read();
  if (!row) {
    const wrapped = wrapDek(keyring, orgId, generateDek());
    await tx
      .insert(orgDataKeys)
      .values({ orgId, kekVersion: wrapped.kekVersion, wrappedDek: wrapped.wrapped })
      .onConflictDoNothing();
    [row] = await read();
  }
  if (!row) throw new Error('Could not create the organization data key');
  return unwrapDek(keyring, orgId, { kekVersion: row.kekVersion, wrapped: row.wrappedDek });
}
```

`packages/connections/src/audit.ts`:
```ts
import { auditLog, type Tx } from '@agile/db';

export type AuditAction =
  | 'jira_connection.created'
  | 'jira_connection.retested'
  | 'jira_connection.deleted'
  | 'jira_connection.token_refreshed'
  | 'llm_connection.created'
  | 'llm_connection.retested'
  | 'llm_connection.deleted'
  | 'llm_connection.default_changed';

/** metadata must never contain secrets — pass only non-sensitive descriptors. */
export async function recordAudit(
  tx: Tx,
  entry: {
    orgId: string;
    actorUserId: string | null;
    action: AuditAction;
    targetType: string;
    targetId: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(auditLog).values({ ...entry, metadata: entry.metadata ?? {} });
}
```

- [ ] **Step 3: Shared test helpers**

`packages/connections/src/test-helpers.ts`:
```ts
import { parseKeyring } from '@agile/crypto';
import { createDb } from '@agile/db';
import { startTestDatabase, type TestDatabase } from '@agile/db/testing';
import type { JiraCredentials, JiraTestResult } from '@agile/jira';
import type { Actor } from './actor';

export const keyring = parseKeyring(`v1:${Buffer.alloc(32, 7).toString('base64')}`);
export const owner = (orgId = 'org_a'): Actor => ({ orgId, userId: `user_${orgId}`, roles: ['owner'] });
export const member = (orgId = 'org_a'): Actor => ({ orgId, userId: 'user_m', roles: ['member'] });

export const okJira =
  (displayName = 'Pat') =>
  async (c: JiraCredentials): Promise<JiraTestResult> => ({
    ok: true,
    deployment: c.kind === 'datacenter_pat' ? 'datacenter' : 'cloud',
    version: '10.3.0',
    account: { id: 'acc-1', displayName },
  });

export async function startHarness() {
  const tdb: TestDatabase = await startTestDatabase();
  const app = createDb(tdb.appUrl, { max: 4 });
  const owner_ = createDb(tdb.ownerUrl, { max: 1 }); // bypasses RLS, for inspecting raw rows
  return {
    db: app.db,
    rawDb: owner_.db,
    stop: async () => {
      await app.close();
      await owner_.close();
      await tdb.stop();
    },
  };
}
```

- [ ] **Step 4: Write the failing service tests**

`packages/connections/src/jira-connections.test.ts`:
```ts
import { auditLog, jiraConnections } from '@agile/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from './errors';
import {
  type ConnectionDeps,
  createJiraConnection,
  deleteJiraConnection,
  listJiraConnections,
  loadJiraSecret,
  retestJiraConnection,
} from './jira-connections';
import { keyring, member, okJira, owner, startHarness } from './test-helpers';

const dc = (n: number, token = 'pat-secret-value') => ({
  name: `Corp Jira ${n}`,
  credentials: { kind: 'datacenter_pat' as const, baseUrl: `https://jira${n}.corp.example`, token },
});

describe('jira connections', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let deps: ConnectionDeps;

  beforeAll(async () => {
    h = await startHarness();
    deps = { db: h.db, keyring, allowedPrivateHosts: [], testJira: okJira() };
  });
  afterAll(async () => h?.stop());

  it('stores the secret encrypted and never exposes it', async () => {
    const r = await createJiraConnection(deps, owner(), dc(1));
    expect(r).toMatchObject({ ok: true, connection: { name: 'Corp Jira 1', status: 'ok', accountName: 'Pat' } });
    expect(JSON.stringify(r)).not.toContain('pat-secret-value');

    const [raw] = await h.rawDb.select().from(jiraConnections);
    expect(raw?.secret.startsWith('s1.')).toBe(true);
    expect(raw?.secret).not.toContain('pat-secret-value');

    const listed = await listJiraConnections(deps, 'org_a');
    expect(JSON.stringify(listed)).not.toContain('s1.');

    const secret = await loadJiraSecret(deps, 'org_a', r.ok ? r.connection.id : '');
    expect(secret?.credentials).toMatchObject({ kind: 'datacenter_pat', token: 'pat-secret-value' });
  });

  it('writes an audit entry without secrets', async () => {
    const audits = await h.rawDb.select().from(auditLog);
    const created = audits.find((a) => a.action === 'jira_connection.created');
    expect(created?.metadata).toMatchObject({ deployment: 'datacenter', authType: 'pat' });
    expect(JSON.stringify(audits)).not.toContain('pat-secret-value');
  });

  it('does not save a connection that fails its test', async () => {
    const failing: ConnectionDeps = {
      ...deps,
      testJira: async () => ({ ok: false, code: 'unauthorized', message: 'Jira rejected these credentials.' }),
    };
    const r = await createJiraConnection(failing, owner(), dc(2));
    expect(r).toMatchObject({ ok: false, code: 'unauthorized' });
    expect((await listJiraConnections(deps, 'org_a')).map((c) => c.name)).not.toContain('Corp Jira 2');
  });

  it('rejects a duplicate base URL in the same org (after normalisation)', async () => {
    const dup = { ...dc(1), credentials: { ...dc(1).credentials, baseUrl: 'https://jira1.corp.example/' } };
    expect(await createJiraConnection(deps, owner(), dup)).toMatchObject({ ok: false, code: 'duplicate' });
  });

  it('only lets owners/admins manage connections', async () => {
    await expect(createJiraConnection(deps, member(), dc(3))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("cannot see, retest, or delete another org's connection", async () => {
    const [a] = await listJiraConnections(deps, 'org_a');
    expect(await listJiraConnections(deps, 'org_b')).toEqual([]);
    expect(await loadJiraSecret(deps, 'org_b', a?.id ?? '')).toBeNull();
    expect(await retestJiraConnection(deps, owner('org_b'), a?.id ?? '')).toMatchObject({ code: 'not_found' });
    expect(await deleteJiraConnection(deps, owner('org_b'), a?.id ?? '')).toMatchObject({ code: 'not_found' });
  });

  it('records a failed retest on the connection', async () => {
    const [a] = await listJiraConnections(deps, 'org_a');
    const failing: ConnectionDeps = {
      ...deps,
      testJira: async () => ({ ok: false, code: 'unauthorized', message: 'Jira rejected these credentials.' }),
    };
    const r = await retestJiraConnection(failing, owner(), a?.id ?? '');
    expect(r).toMatchObject({ ok: true, connection: { status: 'error', lastError: 'unauthorized' } });
  });

  it('creates the org key once when two connections are saved concurrently for a new org', async () => {
    const results = await Promise.all([
      createJiraConnection(deps, owner('org_new'), dc(10)),
      createJiraConnection(deps, owner('org_new'), dc(11)),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    const secrets = await Promise.all(
      (await listJiraConnections(deps, 'org_new')).map((c) => loadJiraSecret(deps, 'org_new', c.id)),
    );
    expect(secrets.every((s) => s !== null)).toBe(true);
  });

  it('deletes and audits', async () => {
    const [a] = await listJiraConnections(deps, 'org_a');
    expect(await deleteJiraConnection(deps, owner(), a?.id ?? '')).toEqual({ ok: true });
    expect(await listJiraConnections(deps, 'org_a')).toEqual([]);
  });
});
```

- [ ] **Step 5: Run to verify failure**

Run: `pnpm install && pnpm vitest run --project connections`
Expected: FAIL — `Cannot find module './jira-connections'`.

- [ ] **Step 6: Implement the service**

`packages/connections/src/jira-connections.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { decryptSecret, encryptSecret, type Keyring } from '@agile/crypto';
import { type Db, isUniqueViolation, jiraConnections, type Tx, withOrg } from '@agile/db';
import {
  type JiraCredentials,
  type JiraFailureCode,
  normalizeCredentials,
  testJiraConnection,
} from '@agile/jira';
import type { Resolver } from '@agile/net';
import { desc, eq } from 'drizzle-orm';
import { type Actor, assertCanManage } from './actor';
import { recordAudit } from './audit';
import { getOrgDek } from './vault';

export interface ConnectionDeps {
  db: Db;
  keyring: Keyring;
  allowedPrivateHosts: readonly string[];
  resolve?: Resolver;
  testJira?: typeof testJiraConnection;
  atlassianApiBase?: string;
}

export interface StoredJiraSecret {
  credentials: JiraCredentials;
  oauth?: { refreshToken: string; expiresAt: string };
}

export interface JiraConnectionView {
  id: string;
  name: string;
  deployment: 'cloud' | 'datacenter';
  authType: 'basic' | 'oauth' | 'pat';
  baseUrl: string;
  accountName: string | null;
  status: 'untested' | 'ok' | 'error';
  lastError: string | null;
  lastCheckedAt: Date | null;
  createdAt: Date;
}

export type ServiceFailure = {
  ok: false;
  code: JiraFailureCode | 'duplicate' | 'not_found';
  message: string;
};

const AUTH_TYPE = { cloud_basic: 'basic', cloud_oauth: 'oauth', datacenter_pat: 'pat' } as const;
const secretContext = (id: string) => `jira_connection:${id}`;
const notFound: ServiceFailure = { ok: false, code: 'not_found', message: 'Connection not found.' };

const toView = (r: typeof jiraConnections.$inferSelect): JiraConnectionView => ({
  id: r.id,
  name: r.name,
  deployment: r.deployment,
  authType: r.authType,
  baseUrl: r.baseUrl,
  accountName: r.accountName,
  status: r.status,
  lastError: r.lastError,
  lastCheckedAt: r.lastCheckedAt,
  createdAt: r.createdAt,
});

const runTest = (deps: ConnectionDeps, creds: JiraCredentials) =>
  (deps.testJira ?? testJiraConnection)(creds, {
    allowedPrivateHosts: deps.allowedPrivateHosts,
    resolve: deps.resolve,
    atlassianApiBase: deps.atlassianApiBase,
  });

export async function readSecret(tx: Tx, deps: ConnectionDeps, orgId: string, id: string, encrypted: string) {
  const dek = await getOrgDek(tx, deps.keyring, orgId);
  return JSON.parse(decryptSecret(dek, secretContext(id), encrypted)) as StoredJiraSecret;
}

export async function writeSecret(tx: Tx, deps: ConnectionDeps, orgId: string, id: string, secret: StoredJiraSecret) {
  const dek = await getOrgDek(tx, deps.keyring, orgId);
  return encryptSecret(dek, secretContext(id), JSON.stringify(secret));
}

export async function createJiraConnection(
  deps: ConnectionDeps,
  actor: Actor,
  input: { name: string; credentials: JiraCredentials; oauth?: StoredJiraSecret['oauth'] },
): Promise<{ ok: true; connection: JiraConnectionView } | ServiceFailure> {
  assertCanManage(actor);
  let credentials: JiraCredentials;
  try {
    credentials = normalizeCredentials(input.credentials);
  } catch {
    return { ok: false, code: 'invalid_input', message: 'Enter the full Jira URL.' };
  }
  const test = await runTest(deps, credentials); // network call stays outside the transaction
  if (!test.ok) return test;

  const id = randomUUID();
  try {
    const row = await withOrg(deps.db, actor.orgId, async (tx) => {
      const secret = await writeSecret(tx, deps, actor.orgId, id, { credentials, oauth: input.oauth });
      const [inserted] = await tx
        .insert(jiraConnections)
        .values({
          id,
          orgId: actor.orgId,
          name: input.name.trim(),
          deployment: test.deployment,
          authType: AUTH_TYPE[credentials.kind],
          baseUrl: credentials.baseUrl,
          cloudId: credentials.kind === 'cloud_oauth' ? credentials.cloudId : null,
          accountId: test.account.id,
          accountName: test.account.displayName,
          secret,
          status: 'ok',
          lastCheckedAt: new Date(),
          createdBy: actor.userId,
        })
        .returning();
      await recordAudit(tx, {
        orgId: actor.orgId,
        actorUserId: actor.userId,
        action: 'jira_connection.created',
        targetType: 'jira_connection',
        targetId: id,
        metadata: { deployment: test.deployment, authType: AUTH_TYPE[credentials.kind], baseUrl: credentials.baseUrl },
      });
      return inserted;
    });
    if (!row) throw new Error('Insert returned no row');
    return { ok: true, connection: toView(row) };
  } catch (e) {
    if (isUniqueViolation(e)) {
      return { ok: false, code: 'duplicate', message: 'This Jira site is already connected.' };
    }
    throw e;
  }
}

export async function listJiraConnections(deps: ConnectionDeps, orgId: string): Promise<JiraConnectionView[]> {
  const rows = await withOrg(deps.db, orgId, (tx) =>
    tx.select().from(jiraConnections).orderBy(desc(jiraConnections.createdAt)),
  );
  return rows.map(toView);
}

export async function loadJiraSecret(
  deps: ConnectionDeps,
  orgId: string,
  id: string,
): Promise<StoredJiraSecret | null> {
  return withOrg(deps.db, orgId, async (tx) => {
    const [row] = await tx.select().from(jiraConnections).where(eq(jiraConnections.id, id)).limit(1);
    return row ? readSecret(tx, deps, orgId, id, row.secret) : null;
  });
}

export async function retestJiraConnection(
  deps: ConnectionDeps,
  actor: Actor,
  id: string,
): Promise<{ ok: true; connection: JiraConnectionView } | ServiceFailure> {
  assertCanManage(actor);
  const secret = await loadJiraSecret(deps, actor.orgId, id);
  if (!secret) return notFound;
  const test = await runTest(deps, secret.credentials);
  const row = await withOrg(deps.db, actor.orgId, async (tx) => {
    const [updated] = await tx
      .update(jiraConnections)
      .set({
        status: test.ok ? 'ok' : 'error',
        lastError: test.ok ? null : test.code,
        lastCheckedAt: new Date(),
        ...(test.ok ? { accountName: test.account.displayName } : {}),
      })
      .where(eq(jiraConnections.id, id))
      .returning();
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'jira_connection.retested',
      targetType: 'jira_connection',
      targetId: id,
      metadata: { ok: test.ok, ...(test.ok ? {} : { code: test.code }) },
    });
    return updated;
  });
  return row ? { ok: true, connection: toView(row) } : notFound;
}

export async function deleteJiraConnection(
  deps: ConnectionDeps,
  actor: Actor,
  id: string,
): Promise<{ ok: true } | ServiceFailure> {
  assertCanManage(actor);
  return withOrg(deps.db, actor.orgId, async (tx) => {
    const deleted = await tx.delete(jiraConnections).where(eq(jiraConnections.id, id)).returning({ id: jiraConnections.id });
    if (deleted.length === 0) return notFound;
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'jira_connection.deleted',
      targetType: 'jira_connection',
      targetId: id,
    });
    return { ok: true } as const;
  });
}
```

`packages/connections/src/index.ts`:
```ts
export { type Actor, assertCanManage } from './actor';
export { type AuditAction, recordAudit } from './audit';
export { ForbiddenError } from './errors';
export {
  type ConnectionDeps,
  createJiraConnection,
  deleteJiraConnection,
  type JiraConnectionView,
  listJiraConnections,
  loadJiraSecret,
  retestJiraConnection,
  type ServiceFailure,
  type StoredJiraSecret,
} from './jira-connections';
export { getOrgDek } from './vault';
```

- [ ] **Step 7: Run tests**

Run: `pnpm vitest run --project connections && pnpm typecheck && pnpm lint`
Expected: PASS (all 9 tests).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(connections): encrypted, audited, tenant-scoped Jira connection service"
```

---

### Task 8: `@agile/connections` — LLM connection service

**Files:**
- Create: `packages/connections/src/llm-connections.ts`; Modify: `packages/connections/src/index.ts`
- Test: `packages/connections/src/llm-connections.test.ts`

**Interfaces:**
- Consumes: `ConnectionDeps`, `getOrgDek`, `recordAudit`, `assertCanManage`, `ServiceFailure` shape (Task 7); `createLanguageModel`, `probeModel`, `LlmConfig`, `ProbeFailureCode` (Task 6); `checkOutboundUrl` (Task 5).
- Produces:
  - `interface LlmDeps extends ConnectionDeps { probe?: (cfg: LlmConfig) => Promise<LlmProbeResult> }`
  - `interface LlmConnectionView { id: string; label: string; provider: LlmProvider; model: string; baseUrl: string | null; azureResourceName: string | null; keyHint: string | null; isDefault: boolean; status: 'untested' | 'ok' | 'error'; lastError: string | null; lastCheckedAt: Date | null; createdAt: Date }`
  - `type LlmServiceFailure = { ok: false; code: ProbeFailureCode | 'blocked_url' | 'not_found'; message: string }`
  - `createLlmConnection(deps: LlmDeps, actor: Actor, input: { label: string; config: LlmConfig; makeDefault?: boolean }): Promise<{ ok: true; connection: LlmConnectionView } | LlmServiceFailure>`
  - `listLlmConnections(deps: LlmDeps, orgId: string): Promise<LlmConnectionView[]>`
  - `retestLlmConnection(deps: LlmDeps, actor: Actor, id: string)`, `deleteLlmConnection(deps, actor, id)`, `setDefaultLlmConnection(deps, actor, id): Promise<{ ok: true } | LlmServiceFailure>`
  - `loadDefaultLlmConfig(deps: LlmDeps, orgId: string): Promise<LlmConfig | null>` (for Phase 3)

- [ ] **Step 1: Write the failing tests**

`packages/connections/src/llm-connections.test.ts`:
```ts
import { llmConnections } from '@agile/db';
import type { LlmConfig } from '@agile/llm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLlmConnection,
  deleteLlmConnection,
  type LlmDeps,
  listLlmConnections,
  loadDefaultLlmConfig,
  setDefaultLlmConnection,
} from './llm-connections';
import { keyring, owner, startHarness } from './test-helpers';

const anthropic = (apiKey = 'sk-ant-api03-secretvalue-WXYZ'): LlmConfig => ({
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  apiKey,
});

describe('llm connections', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let deps: LlmDeps;

  beforeAll(async () => {
    h = await startHarness();
    deps = { db: h.db, keyring, allowedPrivateHosts: [], probe: async () => ({ ok: true, latencyMs: 5 }) };
  });
  afterAll(async () => h?.stop());

  it('makes the first connection the default and shows only a key hint', async () => {
    const r = await createLlmConnection(deps, owner(), { label: 'Claude', config: anthropic() });
    expect(r).toMatchObject({ ok: true, connection: { isDefault: true, keyHint: '…WXYZ', status: 'ok' } });
    expect(JSON.stringify(await listLlmConnections(deps, 'org_a'))).not.toContain('secretvalue');
    const [raw] = await h.rawDb.select().from(llmConnections);
    expect(raw?.secret).not.toContain('secretvalue');
  });

  it('switches the default atomically', async () => {
    const r = await createLlmConnection(deps, owner(), { label: 'Second', config: anthropic('sk-2-ABCD') });
    if (!r.ok) throw new Error('expected ok');
    expect(r.connection.isDefault).toBe(false);
    expect(await setDefaultLlmConnection(deps, owner(), r.connection.id)).toEqual({ ok: true });
    const list = await listLlmConnections(deps, 'org_a');
    expect(list.filter((c) => c.isDefault).map((c) => c.label)).toEqual(['Second']);
    expect(await loadDefaultLlmConfig(deps, 'org_a')).toMatchObject({ provider: 'anthropic', apiKey: 'sk-2-ABCD' });
  });

  it('does not save a key that fails the probe', async () => {
    const failing: LlmDeps = { ...deps, probe: async () => ({ ok: false, code: 'unauthorized', message: 'x' }) };
    expect(await createLlmConnection(failing, owner(), { label: 'Bad', config: anthropic() })).toMatchObject({
      ok: false,
      code: 'unauthorized',
    });
  });

  it('blocks private OpenAI-compatible endpoints unless allowlisted', async () => {
    const config: LlmConfig = { provider: 'openai_compatible', model: 'llama3.1', baseUrl: 'http://127.0.0.1:11434/v1' };
    expect(await createLlmConnection(deps, owner(), { label: 'Ollama', config })).toMatchObject({
      ok: false,
      code: 'blocked_url',
    });
    const allowed = { ...deps, allowedPrivateHosts: ['127.0.0.1'] };
    expect(await createLlmConnection(allowed, owner(), { label: 'Ollama', config })).toMatchObject({ ok: true });
  });

  it("is invisible to other orgs and deleting the default leaves none", async () => {
    expect(await listLlmConnections(deps, 'org_b')).toEqual([]);
    expect(await loadDefaultLlmConfig(deps, 'org_b')).toBeNull();
    const def = (await listLlmConnections(deps, 'org_a')).find((c) => c.isDefault);
    expect(await deleteLlmConnection(deps, owner('org_b'), def?.id ?? '')).toMatchObject({ code: 'not_found' });
    expect(await deleteLlmConnection(deps, owner(), def?.id ?? '')).toEqual({ ok: true });
    expect(await loadDefaultLlmConfig(deps, 'org_a')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run --project connections src/llm-connections.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/connections/src/llm-connections.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { decryptSecret, encryptSecret } from '@agile/crypto';
import { llmConnections, type Tx, withOrg } from '@agile/db';
import {
  createLanguageModel,
  type LlmConfig,
  type LlmProbeResult,
  type LlmProvider,
  type ProbeFailureCode,
  probeModel,
} from '@agile/llm';
import { checkOutboundUrl } from '@agile/net';
import { desc, eq } from 'drizzle-orm';
import { type Actor, assertCanManage } from './actor';
import { recordAudit } from './audit';
import type { ConnectionDeps } from './jira-connections';
import { getOrgDek } from './vault';

export interface LlmDeps extends ConnectionDeps {
  probe?: (cfg: LlmConfig) => Promise<LlmProbeResult>;
}

export interface LlmConnectionView {
  id: string;
  label: string;
  provider: LlmProvider;
  model: string;
  baseUrl: string | null;
  azureResourceName: string | null;
  keyHint: string | null;
  isDefault: boolean;
  status: 'untested' | 'ok' | 'error';
  lastError: string | null;
  lastCheckedAt: Date | null;
  createdAt: Date;
}

export type LlmServiceFailure = {
  ok: false;
  code: ProbeFailureCode | 'blocked_url' | 'not_found';
  message: string;
};

const notFound: LlmServiceFailure = { ok: false, code: 'not_found', message: 'Connection not found.' };
const secretContext = (id: string) => `llm_connection:${id}`;

const toView = (r: typeof llmConnections.$inferSelect): LlmConnectionView => ({
  id: r.id,
  label: r.label,
  provider: r.provider,
  model: r.model,
  baseUrl: r.baseUrl,
  azureResourceName: r.azureResourceName,
  keyHint: r.keyHint,
  isDefault: r.isDefault,
  status: r.status,
  lastError: r.lastError,
  lastCheckedAt: r.lastCheckedAt,
  createdAt: r.createdAt,
});

function trimConfig(c: LlmConfig): LlmConfig {
  const model = c.model.trim();
  switch (c.provider) {
    case 'openai_compatible':
      return { provider: c.provider, model, baseUrl: c.baseUrl.trim().replace(/\/+$/, ''), apiKey: c.apiKey?.trim() || undefined };
    case 'azure':
      return { provider: c.provider, model, apiKey: c.apiKey.trim(), resourceName: c.resourceName.trim() };
    default:
      return { provider: c.provider, model, apiKey: c.apiKey.trim() };
  }
}

const keyHintOf = (c: LlmConfig) => {
  const key = 'apiKey' in c ? c.apiKey : undefined;
  return key && key.length >= 8 ? `…${key.slice(-4)}` : null;
};

async function probe(deps: LlmDeps, config: LlmConfig): Promise<LlmProbeResult | LlmServiceFailure> {
  if (config.provider === 'openai_compatible') {
    const check = await checkOutboundUrl(config.baseUrl, deps);
    if (!check.ok) return { ok: false, code: 'blocked_url', message: check.reason };
  }
  return deps.probe ? deps.probe(config) : probeModel(createLanguageModel(config));
}

async function readConfig(tx: Tx, deps: LlmDeps, orgId: string, row: typeof llmConnections.$inferSelect) {
  const dek = await getOrgDek(tx, deps.keyring, orgId);
  return JSON.parse(decryptSecret(dek, secretContext(row.id), row.secret)) as LlmConfig;
}

export async function createLlmConnection(
  deps: LlmDeps,
  actor: Actor,
  input: { label: string; config: LlmConfig; makeDefault?: boolean },
): Promise<{ ok: true; connection: LlmConnectionView } | LlmServiceFailure> {
  assertCanManage(actor);
  const config = trimConfig(input.config);
  const result = await probe(deps, config);
  if (!result.ok) return result;

  const id = randomUUID();
  const row = await withOrg(deps.db, actor.orgId, async (tx) => {
    const existingDefault = await tx
      .select({ id: llmConnections.id })
      .from(llmConnections)
      .where(eq(llmConnections.isDefault, true))
      .limit(1);
    const isDefault = input.makeDefault === true || existingDefault.length === 0;
    if (isDefault) await tx.update(llmConnections).set({ isDefault: false }).where(eq(llmConnections.isDefault, true));
    const dek = await getOrgDek(tx, deps.keyring, actor.orgId);
    const [inserted] = await tx
      .insert(llmConnections)
      .values({
        id,
        orgId: actor.orgId,
        label: input.label.trim(),
        provider: config.provider,
        model: config.model,
        baseUrl: config.provider === 'openai_compatible' ? config.baseUrl : null,
        azureResourceName: config.provider === 'azure' ? config.resourceName : null,
        keyHint: keyHintOf(config),
        secret: encryptSecret(dek, secretContext(id), JSON.stringify(config)),
        isDefault,
        status: 'ok',
        lastCheckedAt: new Date(),
        createdBy: actor.userId,
      })
      .returning();
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'llm_connection.created',
      targetType: 'llm_connection',
      targetId: id,
      metadata: { provider: config.provider, model: config.model, isDefault },
    });
    return inserted;
  });
  if (!row) throw new Error('Insert returned no row');
  return { ok: true, connection: toView(row) };
}

export async function listLlmConnections(deps: LlmDeps, orgId: string): Promise<LlmConnectionView[]> {
  const rows = await withOrg(deps.db, orgId, (tx) =>
    tx.select().from(llmConnections).orderBy(desc(llmConnections.createdAt)),
  );
  return rows.map(toView);
}

export async function setDefaultLlmConnection(
  deps: LlmDeps,
  actor: Actor,
  id: string,
): Promise<{ ok: true } | LlmServiceFailure> {
  assertCanManage(actor);
  return withOrg(deps.db, actor.orgId, async (tx) => {
    const [target] = await tx.select({ id: llmConnections.id }).from(llmConnections).where(eq(llmConnections.id, id));
    if (!target) return notFound;
    await tx.update(llmConnections).set({ isDefault: false }).where(eq(llmConnections.isDefault, true));
    await tx.update(llmConnections).set({ isDefault: true }).where(eq(llmConnections.id, id));
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'llm_connection.default_changed',
      targetType: 'llm_connection',
      targetId: id,
    });
    return { ok: true } as const;
  });
}

export async function retestLlmConnection(
  deps: LlmDeps,
  actor: Actor,
  id: string,
): Promise<{ ok: true; connection: LlmConnectionView } | LlmServiceFailure> {
  assertCanManage(actor);
  const config = await withOrg(deps.db, actor.orgId, async (tx) => {
    const [row] = await tx.select().from(llmConnections).where(eq(llmConnections.id, id));
    return row ? readConfig(tx, deps, actor.orgId, row) : null;
  });
  if (!config) return notFound;
  const result = await probe(deps, config);
  const row = await withOrg(deps.db, actor.orgId, async (tx) => {
    const [updated] = await tx
      .update(llmConnections)
      .set({ status: result.ok ? 'ok' : 'error', lastError: result.ok ? null : result.code, lastCheckedAt: new Date() })
      .where(eq(llmConnections.id, id))
      .returning();
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'llm_connection.retested',
      targetType: 'llm_connection',
      targetId: id,
      metadata: { ok: result.ok, ...(result.ok ? {} : { code: result.code }) },
    });
    return updated;
  });
  return row ? { ok: true, connection: toView(row) } : notFound;
}

export async function deleteLlmConnection(
  deps: LlmDeps,
  actor: Actor,
  id: string,
): Promise<{ ok: true } | LlmServiceFailure> {
  assertCanManage(actor);
  return withOrg(deps.db, actor.orgId, async (tx) => {
    const deleted = await tx.delete(llmConnections).where(eq(llmConnections.id, id)).returning({ id: llmConnections.id });
    if (deleted.length === 0) return notFound;
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'llm_connection.deleted',
      targetType: 'llm_connection',
      targetId: id,
    });
    return { ok: true } as const;
  });
}

export async function loadDefaultLlmConfig(deps: LlmDeps, orgId: string): Promise<LlmConfig | null> {
  return withOrg(deps.db, orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(llmConnections)
      .where(eq(llmConnections.isDefault, true))
      .limit(1);
    return row ? readConfig(tx, deps, orgId, row) : null;
  });
}
```

Append to `packages/connections/src/index.ts`:
```ts
export {
  createLlmConnection,
  deleteLlmConnection,
  type LlmConnectionView,
  type LlmDeps,
  type LlmServiceFailure,
  listLlmConnections,
  loadDefaultLlmConfig,
  retestLlmConnection,
  setDefaultLlmConnection,
} from './llm-connections';
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run --project connections && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(connections): BYOK LLM connection service with default selection"
```

---

### Task 9: `apps/web` shell from shadcn blocks — auth, workspaces, i18n, e2e harness

**Files:**
- Create: `apps/web/{package.json,tsconfig.json,next.config.ts,postcss.config.mjs}`, `apps/web/messages/{en,fr}.json`
- Generated by shadcn (then adapted as shown): `apps/web/components.json`, `apps/web/src/app/globals.css`, `apps/web/src/lib/utils.ts`, `apps/web/src/components/ui/*`, `apps/web/src/components/{login-form,signup-form,app-sidebar,nav-main,nav-user,team-switcher,nav-projects}.tsx`, `apps/web/src/app/{login,signup,dashboard}/page.tsx`
- Create: `apps/web/src/app/layout.tsx`, `apps/web/src/app/api/auth/[...all]/route.ts`, `apps/web/src/app/(auth)/{layout.tsx,login/page.tsx,signup/page.tsx,onboarding/page.tsx,onboarding/create-workspace-form.tsx}`, `apps/web/src/app/(app)/{layout.tsx,page.tsx}`, `apps/web/src/app/actions/locale.ts`
- Create: `apps/web/src/components/{workspace-switcher,page-breadcrumb}.tsx`, `apps/web/src/proxy.ts`, `apps/web/src/i18n/request.ts`, `apps/web/src/lib/auth-client.ts`, `apps/web/src/server/context.ts`
- Delete (block scaffolding we replace): `apps/web/src/app/{login,signup,dashboard}/`, `apps/web/src/components/{team-switcher,nav-projects}.tsx`
- Create: `e2e/{package.json,playwright.config.ts,global-setup.ts,helpers.ts,mocks/serve.ts}`, `e2e/tests/onboarding.spec.ts`

**UI rule for this and every later UI task:** start from a shadcn block or component and adapt it (wire data, translate strings, remove what we don't support). Blocks used here: `login-03`, `signup-03`, `sidebar-07`. Components: `field`, `item`, `empty`, `badge`, `native-select`, `radio-group`, `sonner`, `breadcrumb`, `avatar`, `dropdown-menu`. No custom CSS beyond the Tailwind utility classes the blocks already use.

**Interfaces:**
- Consumes: `serverEnv` (Task 1), `parseKeyring` (Task 2), `createDb` (Task 3), `createAuth`, `getMemberRoles`, `canManageConnections` (Task 4), `ConnectionDeps`/`LlmDeps` (Tasks 7–8).
- Produces (server-only, `@/server/context`):
  - `services(): { env: ServerEnv; db: Db; auth: Auth; keyring: Keyring }`
  - `connectionDeps(): LlmDeps` (= `{ db, keyring, allowedPrivateHosts: env.ALLOWED_PRIVATE_HOSTS }`)
  - `type SessionActor = Actor & { user: { id: string; name: string; email: string } }`
  - `requireActor(): Promise<SessionActor>` (redirects to `/login` or `/onboarding`), `requireSignedIn()`
- Produces (UI): `AppSidebar({ user })`, `NavMain({ label, items })`, `NavUser({ user })`, `WorkspaceSwitcher()`, `PageBreadcrumb()`; `<Toaster />` mounted in the root layout so later tasks can call `toast.success(...)` from `sonner`.
- Produces (e2e): `signUpWithWorkspace(page: Page): Promise<{ email: string }>` in `e2e/helpers.ts`; `connectionItem(page, name)` locator helper; mock servers on fixed ports — Jira DC `4010` (valid `Bearer good-pat`), OpenAI-compatible `4020` (valid key `good-key`).

- [ ] **Step 1: Create the Next app**

`apps/web/package.json`:
```json
{
  "name": "@agile/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@agile/auth": "workspace:*",
    "@agile/config": "workspace:*",
    "@agile/connections": "workspace:*",
    "@agile/crypto": "workspace:*",
    "@agile/db": "workspace:*",
    "@agile/jira": "workspace:*",
    "@agile/llm": "workspace:*",
    "@agile/net": "workspace:*",
    "better-auth": "1.7.7",
    "next": "16.3.8",
    "next-intl": "4.14.9",
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "server-only": "^0.0.1",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "4.3.3",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "tailwindcss": "4.3.3"
  }
}
```

`apps/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "allowJs": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "src", ".next/types/**/*.ts", ".next/dev/types/**/*.ts", "next.config.ts"]
}
```

`apps/web/next.config.ts`:
```ts
import path from 'node:path';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  transpilePackages: [
    '@agile/auth',
    '@agile/config',
    '@agile/connections',
    '@agile/crypto',
    '@agile/db',
    '@agile/jira',
    '@agile/llm',
    '@agile/net',
  ],
  serverExternalPackages: ['postgres'],
};

export default withNextIntl(config);
```

`apps/web/postcss.config.mjs`:
```js
export default { plugins: { '@tailwindcss/postcss': {} } };
```

Create `apps/web/src/app/globals.css` containing only `@import "tailwindcss";` (shadcn init extends it).

- [ ] **Step 2: Install shadcn (Radix base) and pull the blocks**

Run from `apps/web`:
```bash
pnpm dlx shadcn@4.21.1 init --base radix --no-monorepo --yes
pnpm dlx shadcn@4.21.1 add login-03 signup-03 sidebar-07 --yes
pnpm dlx shadcn@4.21.1 add field item empty badge native-select radio-group sonner alert --yes
```
Expected:
- `components.json` exists and generated components import from `radix-ui` (the default preset `base-nova` uses Base UI, whose `render` prop differs from the `asChild` used in this plan — `--base radix` is required).
- `src/components/ui/` contains `button card input label field separator sidebar breadcrumb collapsible dropdown-menu avatar item empty badge native-select radio-group sonner alert tooltip sheet skeleton`.
- Block files: `src/app/login/page.tsx`, `src/app/signup/page.tsx`, `src/app/dashboard/page.tsx`, `src/components/login-form.tsx`, `src/components/signup-form.tsx`, `src/components/app-sidebar.tsx`, `src/components/nav-main.tsx`, `src/components/nav-projects.tsx`, `src/components/nav-user.tsx`, `src/components/team-switcher.tsx`.
- `globals.css` has the theme tokens for light and dark (including `--sidebar-*`).

If the CLI writes different paths (e.g. without `src/`), move them to the paths above before continuing. Never hand-edit `src/components/ui/*`.

Delete the block demo routes and the parts we replace:
```bash
rm -r src/app/login src/app/signup src/app/dashboard
rm src/components/nav-projects.tsx
git mv src/components/team-switcher.tsx src/components/workspace-switcher.tsx 2>/dev/null || mv src/components/team-switcher.tsx src/components/workspace-switcher.tsx
```

- [ ] **Step 3: Messages (EN/FR)**

`apps/web/messages/en.json`:
```json
{
  "brand": "Agile Copilot",
  "auth": {
    "loginTitle": "Welcome back",
    "loginDescription": "Sign in to your workspace",
    "signupTitle": "Create your account",
    "signupDescription": "Start tracking your delivery in minutes",
    "name": "Full name",
    "email": "Email",
    "password": "Password",
    "confirmPassword": "Confirm password",
    "passwordHint": "Must be at least 10 characters long.",
    "passwordMismatch": "Passwords do not match.",
    "signIn": "Sign in",
    "signUp": "Create account",
    "noAccount": "Don't have an account?",
    "signUpLink": "Sign up",
    "haveAccount": "Already have an account?",
    "signInLink": "Sign in",
    "genericError": "Something went wrong. Please try again."
  },
  "onboarding": {
    "title": "Create your workspace",
    "description": "A workspace holds your team's Jira connections, AI model and settings.",
    "workspaceName": "Workspace name",
    "submit": "Create workspace"
  },
  "nav": {
    "platform": "Workspace",
    "dashboard": "Dashboard",
    "settings": "Settings",
    "jira": "Jira",
    "llm": "AI model",
    "signOut": "Log out",
    "switchLanguage": "Français",
    "workspaces": "Workspaces",
    "addWorkspace": "New workspace"
  },
  "dashboard": {
    "title": "Get started",
    "connectJira": "Connect Jira",
    "connectJiraHint": "Read your boards, sprints and issues.",
    "connectLlm": "Connect an AI model",
    "connectLlmHint": "Your own key powers the assistant.",
    "done": "Done",
    "todo": "To do"
  }
}
```

`apps/web/messages/fr.json`:
```json
{
  "brand": "Agile Copilot",
  "auth": {
    "loginTitle": "Bon retour",
    "loginDescription": "Connectez-vous à votre espace",
    "signupTitle": "Créer votre compte",
    "signupDescription": "Suivez vos livraisons en quelques minutes",
    "name": "Nom complet",
    "email": "E-mail",
    "password": "Mot de passe",
    "confirmPassword": "Confirmer le mot de passe",
    "passwordHint": "Au moins 10 caractères.",
    "passwordMismatch": "Les mots de passe ne correspondent pas.",
    "signIn": "Se connecter",
    "signUp": "Créer un compte",
    "noAccount": "Pas encore de compte ?",
    "signUpLink": "S'inscrire",
    "haveAccount": "Déjà un compte ?",
    "signInLink": "Se connecter",
    "genericError": "Une erreur est survenue. Veuillez réessayer."
  },
  "onboarding": {
    "title": "Créer votre espace de travail",
    "description": "Un espace regroupe les connexions Jira, le modèle d'IA et les réglages de votre équipe.",
    "workspaceName": "Nom de l'espace",
    "submit": "Créer l'espace"
  },
  "nav": {
    "platform": "Espace",
    "dashboard": "Tableau de bord",
    "settings": "Réglages",
    "jira": "Jira",
    "llm": "Modèle d'IA",
    "signOut": "Se déconnecter",
    "switchLanguage": "English",
    "workspaces": "Espaces",
    "addWorkspace": "Nouvel espace"
  },
  "dashboard": {
    "title": "Pour commencer",
    "connectJira": "Connecter Jira",
    "connectJiraHint": "Lire vos tableaux, sprints et tickets.",
    "connectLlm": "Connecter un modèle d'IA",
    "connectLlmHint": "Votre propre clé alimente l'assistant.",
    "done": "Fait",
    "todo": "À faire"
  }
}
```

- [ ] **Step 4: i18n, auth client, server context, proxy, auth route, locale action**

`apps/web/src/i18n/request.ts`:
```ts
import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

export const LOCALES = ['en', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];

const pick = (value: string | null | undefined): Locale | null => {
  const l = value?.slice(0, 2).toLowerCase();
  return (LOCALES as readonly string[]).includes(l ?? '') ? (l as Locale) : null;
};

export default getRequestConfig(async () => {
  const locale =
    pick((await cookies()).get('locale')?.value) ?? pick((await headers()).get('accept-language')) ?? 'en';
  return { locale, messages: (await import(`../../messages/${locale}.json`)).default };
});
```

`apps/web/src/lib/auth-client.ts`:
```ts
import { organizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({ plugins: [organizationClient()] });
```

`apps/web/src/server/context.ts`:
```ts
import 'server-only';
import { type Auth, createAuth, getMemberRoles } from '@agile/auth';
import { type ServerEnv, serverEnv } from '@agile/config';
import type { Actor, LlmDeps } from '@agile/connections';
import { type Keyring, parseKeyring } from '@agile/crypto';
import { createDb, type Db } from '@agile/db';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';

interface Services {
  env: ServerEnv;
  db: Db;
  auth: Auth;
  keyring: Keyring;
}

// Survives dev hot-reloads so we don't open a new pool per edit. Built lazily so `next build` needs no env.
const g = globalThis as unknown as { __agileServices?: Services };

export function services(): Services {
  if (!g.__agileServices) {
    const env = serverEnv();
    const { db } = createDb(env.DATABASE_URL);
    g.__agileServices = {
      env,
      db,
      auth: createAuth({ db, secret: env.BETTER_AUTH_SECRET, baseURL: env.BETTER_AUTH_URL }),
      keyring: parseKeyring(env.ENCRYPTION_KEYS),
    };
  }
  return g.__agileServices;
}

export function connectionDeps(): LlmDeps {
  const { db, keyring, env } = services();
  return { db, keyring, allowedPrivateHosts: env.ALLOWED_PRIVATE_HOSTS };
}

export type SessionActor = Actor & { user: { id: string; name: string; email: string } };

const loadSession = cache(async () => services().auth.api.getSession({ headers: await headers() }));

export async function requireSignedIn() {
  const session = await loadSession();
  if (!session) redirect('/login');
  return session;
}

export async function requireActor(): Promise<SessionActor> {
  const session = await requireSignedIn();
  const orgId = session.session.activeOrganizationId;
  if (!orgId) redirect('/onboarding');
  const roles = await getMemberRoles(services().db, orgId, session.user.id);
  if (roles.length === 0) redirect('/onboarding');
  const { id, name, email } = session.user;
  return { orgId, userId: id, roles, user: { id, name, email } };
}
```

`apps/web/src/proxy.ts`:
```ts
import { getSessionCookie } from 'better-auth/cookies';
import { type NextRequest, NextResponse } from 'next/server';

const PUBLIC_PREFIXES = ['/login', '/signup', '/api/auth'];

/** Optimistic redirect only — real authorization happens server-side in requireActor(). */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NextResponse.next();
  if (!getSessionCookie(request)) return NextResponse.redirect(new URL('/login', request.url));
  return NextResponse.next();
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
```

`apps/web/src/app/api/auth/[...all]/route.ts`:
```ts
import { toNextJsHandler } from 'better-auth/next-js';
import { services } from '@/server/context';

const handler = () => toNextJsHandler(services().auth);

export const GET = (req: Request) => handler().GET(req);
export const POST = (req: Request) => handler().POST(req);
```

`apps/web/src/app/actions/locale.ts`:
```ts
'use server';

import { cookies } from 'next/headers';
import { LOCALES, type Locale } from '@/i18n/request';

export async function setLocale(locale: Locale) {
  if (!LOCALES.includes(locale)) return;
  (await cookies()).set('locale', locale, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' });
}
```

- [ ] **Step 5: Root layout and auth screens (blocks `login-03` / `signup-03`)**

`apps/web/src/app/layout.tsx`:
```tsx
import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
import type { ReactNode } from 'react';
import { Toaster } from '@/components/ui/sonner';
import './globals.css';

export const metadata: Metadata = { title: 'Agile Copilot' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={await getLocale()}>
      <body className="min-h-svh bg-background text-foreground antialiased">
        <NextIntlClientProvider>
          {children}
          <Toaster />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
```

`apps/web/src/app/(auth)/layout.tsx` (the `login-03` page frame, shared by login, signup and onboarding):
```tsx
import { SquareKanban } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations();
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <span className="flex items-center gap-2 self-center font-medium">
          <span className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <SquareKanban className="size-4" />
          </span>
          {t('brand')}
        </span>
        {children}
      </div>
    </div>
  );
}
```

Replace the generated `apps/web/src/components/login-form.tsx` with the adapted block (social buttons, "forgot password" and terms text removed — not offered in Phase 1):
```tsx
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type ComponentProps, type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth-client';
import { cn } from '@/lib/utils';

export function LoginForm({ className, ...props }: ComponentProps<'div'>) {
  const t = useTranslations('auth');
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const { error } = await authClient.signIn.email({
      email: String(form.get('email')),
      password: String(form.get('password')),
    });
    setPending(false);
    if (error) return setError(error.message ?? t('genericError'));
    router.push('/');
    router.refresh();
  }

  return (
    <div className={cn('flex flex-col gap-6', className)} {...props}>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">{t('loginTitle')}</CardTitle>
          <CardDescription>{t('loginDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="email">{t('email')}</FieldLabel>
                <Input id="email" name="email" type="email" placeholder="m@example.com" autoComplete="email" required />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">{t('password')}</FieldLabel>
                <Input id="password" name="password" type="password" autoComplete="current-password" required />
              </Field>
              {error && <FieldError>{error}</FieldError>}
              <Field>
                <Button type="submit" disabled={pending}>
                  {t('signIn')}
                </Button>
                <FieldDescription className="text-center">
                  {t('noAccount')} <Link href="/signup">{t('signUpLink')}</Link>
                </FieldDescription>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

Replace the generated `apps/web/src/components/signup-form.tsx` with the adapted block:
```tsx
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type ComponentProps, type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth-client';
import { cn } from '@/lib/utils';

export function SignupForm({ className, ...props }: ComponentProps<'div'>) {
  const t = useTranslations('auth');
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const password = String(form.get('password'));
    if (password !== String(form.get('confirmPassword'))) return setError(t('passwordMismatch'));
    setPending(true);
    const { error } = await authClient.signUp.email({
      name: String(form.get('name')),
      email: String(form.get('email')),
      password,
    });
    setPending(false);
    if (error) return setError(error.message ?? t('genericError'));
    router.push('/onboarding');
  }

  return (
    <div className={cn('flex flex-col gap-6', className)} {...props}>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">{t('signupTitle')}</CardTitle>
          <CardDescription>{t('signupDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="name">{t('name')}</FieldLabel>
                <Input id="name" name="name" type="text" autoComplete="name" required />
              </Field>
              <Field>
                <FieldLabel htmlFor="email">{t('email')}</FieldLabel>
                <Input id="email" name="email" type="email" placeholder="m@example.com" autoComplete="email" required />
              </Field>
              <Field>
                <Field className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="password">{t('password')}</FieldLabel>
                    <Input id="password" name="password" type="password" minLength={10} autoComplete="new-password" required />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="confirmPassword">{t('confirmPassword')}</FieldLabel>
                    <Input id="confirmPassword" name="confirmPassword" type="password" minLength={10} autoComplete="new-password" required />
                  </Field>
                </Field>
                <FieldDescription>{t('passwordHint')}</FieldDescription>
              </Field>
              {error && <FieldError>{error}</FieldError>}
              <Field>
                <Button type="submit" disabled={pending}>
                  {t('signUp')}
                </Button>
                <FieldDescription className="text-center">
                  {t('haveAccount')} <Link href="/login">{t('signInLink')}</Link>
                </FieldDescription>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

`apps/web/src/app/(auth)/login/page.tsx`:
```tsx
import { LoginForm } from '@/components/login-form';

export default function LoginPage() {
  return <LoginForm />;
}
```

`apps/web/src/app/(auth)/signup/page.tsx`:
```tsx
import { SignupForm } from '@/components/signup-form';

export default function SignupPage() {
  return <SignupForm />;
}
```

`apps/web/src/app/(auth)/onboarding/page.tsx`:
```tsx
import { getTranslations } from 'next-intl/server';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireSignedIn } from '@/server/context';
import { CreateWorkspaceForm } from './create-workspace-form';

export default async function OnboardingPage() {
  await requireSignedIn();
  const t = await getTranslations('onboarding');
  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-xl">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <CreateWorkspaceForm />
      </CardContent>
    </Card>
  );
}
```

`apps/web/src/app/(auth)/onboarding/create-workspace-form.tsx`:
```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth-client';

const slugify = (name: string) =>
  `${
    name
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .slice(0, 40) || 'workspace'
  }-${crypto.randomUUID().slice(0, 6)}`;

export function CreateWorkspaceForm() {
  const t = useTranslations('onboarding');
  const tAuth = useTranslations('auth');
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    const name = String(new FormData(e.currentTarget).get('name')).trim();
    const created = await authClient.organization.create({ name, slug: slugify(name) });
    if (created.error || !created.data) {
      setPending(false);
      return setError(created.error?.message ?? tAuth('genericError'));
    }
    await authClient.organization.setActive({ organizationId: created.data.id });
    router.push('/');
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="name">{t('workspaceName')}</FieldLabel>
          <Input id="name" name="name" required maxLength={80} />
        </Field>
        {error && <FieldError>{error}</FieldError>}
        <Field>
          <Button type="submit" disabled={pending}>
            {t('submit')}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
```

- [ ] **Step 6: App shell (block `sidebar-07`)**

Replace the generated `apps/web/src/components/app-sidebar.tsx`:
```tsx
'use client';

import { Bot, LayoutDashboard, PlugZap } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ComponentProps } from 'react';
import { NavMain } from '@/components/nav-main';
import { NavUser } from '@/components/nav-user';
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarRail } from '@/components/ui/sidebar';
import { WorkspaceSwitcher } from '@/components/workspace-switcher';

export function AppSidebar({
  user,
  ...props
}: ComponentProps<typeof Sidebar> & { user: { name: string; email: string } }) {
  const t = useTranslations('nav');
  const items = [
    { title: t('dashboard'), url: '/', icon: LayoutDashboard },
    { title: t('jira'), url: '/settings/jira', icon: PlugZap },
    { title: t('llm'), url: '/settings/llm', icon: Bot },
  ];
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <WorkspaceSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <NavMain label={t('platform')} items={items} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
```

Replace the generated `apps/web/src/components/nav-main.tsx` (flat links with the active route highlighted; submenus come back when pages need them):
```tsx
'use client';

import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

export function NavMain({
  label,
  items,
}: {
  label: string;
  items: { title: string; url: string; icon: LucideIcon }[];
}) {
  const pathname = usePathname();
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => {
          const active = item.url === '/' ? pathname === '/' : pathname.startsWith(item.url);
          return (
            <SidebarMenuItem key={item.url}>
              <SidebarMenuButton asChild tooltip={item.title} isActive={active}>
                <Link href={item.url}>
                  <item.icon />
                  <span>{item.title}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}
```

Replace the generated `apps/web/src/components/nav-user.tsx` (keeps the block's avatar dropdown; menu offers language switch and log out):
```tsx
'use client';

import { ChevronsUpDown, Languages, LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { setLocale } from '@/app/actions/locale';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { authClient } from '@/lib/auth-client';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || '?';

export function NavUser({ user }: { user: { name: string; email: string } }) {
  const { isMobile } = useSidebar();
  const t = useTranslations('nav');
  const locale = useLocale();
  const router = useRouter();

  const identity = (
    <>
      <Avatar className="h-8 w-8 rounded-lg">
        <AvatarFallback className="rounded-lg">{initials(user.name)}</AvatarFallback>
      </Avatar>
      <div className="grid flex-1 text-left text-sm leading-tight">
        <span className="truncate font-medium">{user.name}</span>
        <span className="truncate text-xs">{user.email}</span>
      </div>
    </>
  );

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              {identity}
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? 'bottom' : 'right'}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">{identity}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={async () => {
                await setLocale(locale === 'fr' ? 'en' : 'fr');
                router.refresh();
              }}
            >
              <Languages />
              {t('switchLanguage')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={async () => {
                await authClient.signOut();
                router.push('/login');
              }}
            >
              <LogOut />
              {t('signOut')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
```

Replace `apps/web/src/components/workspace-switcher.tsx` (the block's team switcher, backed by better-auth organizations):
```tsx
'use client';

import { ChevronsUpDown, Plus, SquareKanban } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { authClient } from '@/lib/auth-client';

export function WorkspaceSwitcher() {
  const { isMobile } = useSidebar();
  const t = useTranslations('nav');
  const router = useRouter();
  const { data: workspaces } = authClient.useListOrganizations();
  const { data: active } = authClient.useActiveOrganization();

  if (!active) return null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <SquareKanban className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{active.name}</span>
              </div>
              <ChevronsUpDown className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            align="start"
            side={isMobile ? 'bottom' : 'right'}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">{t('workspaces')}</DropdownMenuLabel>
            {workspaces?.map((w) => (
              <DropdownMenuItem
                key={w.id}
                className="gap-2 p-2"
                onSelect={async () => {
                  await authClient.organization.setActive({ organizationId: w.id });
                  router.refresh();
                }}
              >
                <div className="flex size-6 items-center justify-center rounded-md border">
                  <SquareKanban className="size-3.5 shrink-0" />
                </div>
                {w.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-2 p-2" onSelect={() => router.push('/onboarding')}>
              <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                <Plus className="size-4" />
              </div>
              <div className="font-medium text-muted-foreground">{t('addWorkspace')}</div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
```

`apps/web/src/components/page-breadcrumb.tsx` (the block's header breadcrumb, driven by the route):
```tsx
'use client';

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Fragment } from 'react';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

const TRAILS: Record<string, ('dashboard' | 'settings' | 'jira' | 'llm')[]> = {
  '/': ['dashboard'],
  '/settings/jira': ['settings', 'jira'],
  '/settings/llm': ['settings', 'llm'],
};

export function PageBreadcrumb() {
  const t = useTranslations('nav');
  const trail = TRAILS[usePathname()] ?? [];
  return (
    <Breadcrumb>
      <BreadcrumbList>
        {trail.map((key, i) => (
          <Fragment key={key}>
            {i > 0 && <BreadcrumbSeparator className="hidden md:block" />}
            <BreadcrumbItem className={i < trail.length - 1 ? 'hidden md:block' : undefined}>
              <BreadcrumbPage>{t(key)}</BreadcrumbPage>
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
```

`apps/web/src/app/(app)/layout.tsx` (the `sidebar-07` page frame):
```tsx
import type { ReactNode } from 'react';
import { AppSidebar } from '@/components/app-sidebar';
import { PageBreadcrumb } from '@/components/page-breadcrumb';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { requireActor } from '@/server/context';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const actor = await requireActor();
  return (
    <SidebarProvider>
      <AppSidebar user={actor.user} />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
            <PageBreadcrumb />
          </div>
        </header>
        <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
          <div className="mx-auto w-full max-w-4xl">{children}</div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
```

`apps/web/src/app/(app)/page.tsx` (get-started checklist built from `Item`):
```tsx
import { listJiraConnections, listLlmConnections } from '@agile/connections';
import { Bot, PlugZap } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Badge } from '@/components/ui/badge';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import { connectionDeps, requireActor } from '@/server/context';

export default async function DashboardPage() {
  const actor = await requireActor();
  const t = await getTranslations('dashboard');
  const deps = connectionDeps();
  const [jira, llm] = await Promise.all([
    listJiraConnections(deps, actor.orgId),
    listLlmConnections(deps, actor.orgId),
  ]);
  const steps = [
    {
      href: '/settings/jira',
      icon: PlugZap,
      title: t('connectJira'),
      hint: t('connectJiraHint'),
      done: jira.some((c) => c.status === 'ok'),
    },
    {
      href: '/settings/llm',
      icon: Bot,
      title: t('connectLlm'),
      hint: t('connectLlmHint'),
      done: llm.some((c) => c.status === 'ok'),
    },
  ];
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
      <ItemGroup className="gap-3">
        {steps.map((s) => (
          <Item key={s.href} variant="outline" asChild>
            <Link href={s.href}>
              <ItemMedia variant="icon">
                <s.icon />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{s.title}</ItemTitle>
                <ItemDescription>{s.hint}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Badge variant={s.done ? 'default' : 'secondary'}>{s.done ? t('done') : t('todo')}</Badge>
              </ItemActions>
            </Link>
          </Item>
        ))}
      </ItemGroup>
    </div>
  );
}
```

- [ ] **Step 7: E2E harness**

`e2e/package.json`:
```json
{
  "name": "@agile/e2e",
  "private": true,
  "type": "module",
  "scripts": { "test": "playwright test", "mocks": "tsx mocks/serve.ts" },
  "devDependencies": {
    "@agile/db": "workspace:*",
    "@agile/jira": "workspace:*",
    "@agile/llm": "workspace:*",
    "@playwright/test": "1.63.0",
    "tsx": "^4.20.0"
  }
}
```

`e2e/mocks/serve.ts`:
```ts
import { createServer, request } from 'node:http';
import { startMockJira } from '@agile/jira/testing';
import { startMockOpenAI } from '@agile/llm/testing';

// The mocks listen on random ports; expose them on fixed ports via a tiny reverse proxy.
async function expose(port: number, target: string) {
  const t = new URL(target);
  const server = createServer((req, res) => {
    const upstream = request(
      { host: t.hostname, port: t.port, path: req.url, method: req.method, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
}

const jira = await startMockJira({ flavor: 'datacenter', validAuthorization: 'Bearer good-pat' });
const llm = await startMockOpenAI({ validKey: 'good-key' });
await expose(4010, jira.url);
await expose(4020, new URL(llm.baseUrl).origin);
console.log('mocks ready: jira http://127.0.0.1:4010, llm http://127.0.0.1:4020/v1');
```

`e2e/global-setup.ts`:
```ts
import { runMigrations } from '@agile/db';

export default async function globalSetup() {
  await runMigrations(process.env.DATABASE_OWNER_URL ?? 'postgres://agile:agile_dev_password@localhost:5432/agile');
}
```

`e2e/playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test';

const env = {
  DATABASE_URL: 'postgres://app_user:app_user_dev_password@localhost:5432/agile',
  BETTER_AUTH_SECRET: 'e2e-secret-e2e-secret-e2e-secret-0000',
  BETTER_AUTH_URL: 'http://localhost:3100',
  ENCRYPTION_KEYS: `v1:${Buffer.alloc(32, 9).toString('base64')}`,
  ALLOWED_PRIVATE_HOSTS: '127.0.0.1',
};

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  use: { baseURL: 'http://localhost:3100', trace: 'retain-on-failure' },
  webServer: [
    { command: 'pnpm mocks', port: 4010, reuseExistingServer: !process.env.CI },
    {
      command: 'pnpm --filter @agile/web exec next dev --port 3100',
      url: 'http://localhost:3100/login',
      env,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
```

`e2e/helpers.ts`:
```ts
import { expect, type Page } from '@playwright/test';

export async function signUpWithWorkspace(page: Page): Promise<{ email: string }> {
  const email = `pm+${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  await page.goto('/signup');
  await page.getByLabel('Full name').fill('Pat Manager');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
  await page.getByLabel('Confirm password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByLabel('Workspace name').fill('Acme Delivery');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible();
  return { email };
}

/** A connection row on a settings page (shadcn Item renders data-slot="item"). */
export const connectionItem = (page: Page, name: string) =>
  page.locator('[data-slot="item"]').filter({ hasText: name });
```

`e2e/tests/onboarding.spec.ts`:
```ts
import { expect, test } from '@playwright/test';
import { signUpWithWorkspace } from '../helpers';

test('signed-out visitors are sent to login', async ({ page }) => {
  await page.goto('/settings/jira');
  await expect(page).toHaveURL(/\/login$/);
});

test('mismatched passwords are caught before sign-up', async ({ page }) => {
  await page.goto('/signup');
  await page.getByLabel('Full name').fill('Pat');
  await page.getByLabel('Email').fill(`pm+${Date.now()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
  await page.getByLabel('Confirm password').fill('correct-horse-batterz');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Passwords do not match.')).toBeVisible();
});

test('a new manager signs up and lands on the get-started checklist', async ({ page }) => {
  await signUpWithWorkspace(page);
  await expect(page.getByText('Connect Jira')).toBeVisible();
  await expect(page.getByText('To do').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Acme Delivery/ })).toBeVisible(); // workspace switcher
});

test('the interface switches to French from the user menu', async ({ page }) => {
  await signUpWithWorkspace(page);
  await page.getByRole('button', { name: /Pat Manager/ }).click();
  await page.getByRole('menuitem', { name: 'Français' }).click();
  await expect(page.getByRole('heading', { name: 'Pour commencer' })).toBeVisible();
});
```

- [ ] **Step 8: Run the app checks and e2e**

Run:
```bash
pnpm install
pnpm --filter @agile/e2e exec playwright install chromium
docker compose up -d postgres
pnpm typecheck && pnpm lint
pnpm e2e
```
Expected: 4 e2e tests PASS. Then `pnpm --filter @agile/web build` succeeds **without** any env set (services are lazy). Check the shell at 375 px width: the sidebar becomes the block's mobile sheet and nothing scrolls horizontally.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(web): shadcn block-based auth, sidebar shell, workspaces, EN/FR, e2e harness"
```

---

### Task 10: Jira connection settings (API token / PAT)

**Files:**
- Create: `apps/web/src/app/(app)/settings/jira/{page.tsx,actions.ts,jira-connection-form.tsx,jira-connection-item.tsx}`
- Modify: `apps/web/messages/{en,fr}.json` (add `jira` namespace)
- Test: `e2e/tests/jira-connection.spec.ts`

**Interfaces:**
- Consumes: `requireActor`, `connectionDeps`, `services` (Task 9); `createJiraConnection`, `listJiraConnections`, `retestJiraConnection`, `deleteJiraConnection`, `ForbiddenError` (Task 7); `canManageConnections` (Task 4); `inferDeployment` (Task 5).
- Produces: `type FormState = { status: 'idle' } | { status: 'ok' } | { status: 'error'; code: string; message?: string }`; server actions `createJiraConnectionAction(prev: FormState, form: FormData): Promise<FormState>`, `retestJiraConnectionAction(id: string): Promise<void>`, `deleteJiraConnectionAction(id: string): Promise<void>`.

- [ ] **Step 1: Write the failing e2e test**

`e2e/tests/jira-connection.spec.ts`:
```ts
import { expect, test } from '@playwright/test';
import { connectionItem, signUpWithWorkspace } from '../helpers';

test('connect a Jira Data Center server with a personal access token', async ({ page }) => {
  await signUpWithWorkspace(page);
  await page.getByRole('link', { name: 'Jira', exact: true }).click();

  await page.getByLabel('Connection name').fill('Corp Jira');
  await page.getByLabel('Jira URL').fill('http://127.0.0.1:4010/browse/ABC-1');
  await page.getByLabel('Data Center / Server').check();
  await page.getByLabel('Personal access token').fill('wrong-pat');
  await page.getByRole('button', { name: 'Test and save' }).click();
  await expect(page.getByText('Jira rejected these credentials.')).toBeVisible();

  await page.getByLabel('Personal access token').fill('  good-pat  ');
  await page.getByRole('button', { name: 'Test and save' }).click();
  const card = connectionItem(page, 'Corp Jira');
  await expect(card.getByText('Connected')).toBeVisible();
  await expect(card.getByText('Pat DC')).toBeVisible();
  await expect(card.getByText('http://127.0.0.1:4010')).toBeVisible();

  await page.goto('/');
  await expect(page.getByText('Done').first()).toBeVisible();
});

test('the same Jira URL cannot be connected twice', async ({ page }) => {
  await signUpWithWorkspace(page);
  await page.goto('/settings/jira');
  for (let i = 0; i < 2; i++) {
    await page.getByLabel('Connection name').fill(`Corp ${i}`);
    await page.getByLabel('Jira URL').fill('http://127.0.0.1:4010');
    await page.getByLabel('Data Center / Server').check();
    await page.getByLabel('Personal access token').fill('good-pat');
    await page.getByRole('button', { name: 'Test and save' }).click();
  }
  await expect(page.getByText('This Jira site is already connected.')).toBeVisible();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm e2e --grep "Jira"`
Expected: FAIL — `/settings/jira` returns 404.

- [ ] **Step 3: Messages**

Add to `apps/web/messages/en.json`:
```json
"jira": {
  "title": "Jira connections",
  "description": "Connect the Jira sites your teams work in. Credentials are tested before they are saved, then encrypted.",
  "empty": "No Jira connected yet.",
  "emptyHint": "Connect a Jira Cloud site or a Data Center server to start.",
  "add": "Add a connection",
  "addDescription": "Use Atlassian sign-in, an API token (Cloud) or a personal access token (Data Center).",
  "saved": "Jira connected.",
  "name": "Connection name",
  "url": "Jira URL",
  "urlHint": "Paste any Jira page link — we'll find the base URL.",
  "type": "Jira type",
  "cloud": "Cloud (atlassian.net)",
  "datacenter": "Data Center / Server",
  "email": "Atlassian account email",
  "apiToken": "API token",
  "apiTokenHint": "Create one at id.atlassian.com → Security → API tokens.",
  "pat": "Personal access token",
  "patHint": "In Jira: Profile → Personal Access Tokens → Create token.",
  "submit": "Test and save",
  "oauth": "Connect with Atlassian",
  "or": "or use an API token",
  "connected": "Connected",
  "failing": "Failing",
  "untested": "Not tested",
  "retest": "Test again",
  "delete": "Remove",
  "readOnlyNotice": "Only workspace owners and admins can change connections.",
  "errors": {
    "invalid_input": "Check the URL and fields.",
    "blocked_url": "This address is private. Ask your administrator to allow it.",
    "unauthorized": "Jira rejected these credentials.",
    "forbidden": "Jira refused access with this token.",
    "not_found": "Connection not found.",
    "not_jira": "No Jira found at this address.",
    "wrong_deployment": "Wrong Jira type selected for this site.",
    "rate_limited": "Jira is busy. Try again in a minute.",
    "unreachable": "Could not reach this Jira server.",
    "duplicate": "This Jira site is already connected.",
    "forbidden_role": "Only workspace owners and admins can change connections.",
    "oauth_failed": "Atlassian sign-in did not complete.",
    "oauth_no_sites": "Your Atlassian account has no Jira sites.",
    "unknown": "Something went wrong."
  },
  "oauthConnected": "{count, plural, one {# Jira site connected.} other {# Jira sites connected.}}"
}
```

Add to `apps/web/messages/fr.json`:
```json
"jira": {
  "title": "Connexions Jira",
  "description": "Connectez les sites Jira de vos équipes. Les identifiants sont testés avant d'être enregistrés, puis chiffrés.",
  "empty": "Aucun Jira connecté pour l'instant.",
  "emptyHint": "Connectez un site Jira Cloud ou un serveur Data Center pour commencer.",
  "add": "Ajouter une connexion",
  "addDescription": "Utilisez la connexion Atlassian, un jeton d'API (Cloud) ou un jeton d'accès personnel (Data Center).",
  "saved": "Jira connecté.",
  "name": "Nom de la connexion",
  "url": "URL de Jira",
  "urlHint": "Collez n'importe quel lien Jira, nous retrouverons l'URL de base.",
  "type": "Type de Jira",
  "cloud": "Cloud (atlassian.net)",
  "datacenter": "Data Center / Server",
  "email": "E-mail du compte Atlassian",
  "apiToken": "Jeton d'API",
  "apiTokenHint": "À créer sur id.atlassian.com → Sécurité → Jetons d'API.",
  "pat": "Jeton d'accès personnel",
  "patHint": "Dans Jira : Profil → Jetons d'accès personnel → Créer un jeton.",
  "submit": "Tester et enregistrer",
  "oauth": "Se connecter avec Atlassian",
  "or": "ou utiliser un jeton d'API",
  "connected": "Connecté",
  "failing": "En erreur",
  "untested": "Non testé",
  "retest": "Tester à nouveau",
  "delete": "Supprimer",
  "readOnlyNotice": "Seuls les propriétaires et administrateurs peuvent modifier les connexions.",
  "errors": {
    "invalid_input": "Vérifiez l'URL et les champs.",
    "blocked_url": "Cette adresse est privée. Demandez à votre administrateur de l'autoriser.",
    "unauthorized": "Jira a refusé ces identifiants.",
    "forbidden": "Jira a refusé l'accès avec ce jeton.",
    "not_found": "Connexion introuvable.",
    "not_jira": "Aucun Jira trouvé à cette adresse.",
    "wrong_deployment": "Mauvais type de Jira sélectionné pour ce site.",
    "rate_limited": "Jira est occupé. Réessayez dans une minute.",
    "unreachable": "Impossible de joindre ce serveur Jira.",
    "duplicate": "Ce site Jira est déjà connecté.",
    "forbidden_role": "Seuls les propriétaires et administrateurs peuvent modifier les connexions.",
    "oauth_failed": "La connexion Atlassian n'a pas abouti.",
    "oauth_no_sites": "Votre compte Atlassian n'a aucun site Jira.",
    "unknown": "Une erreur est survenue."
  },
  "oauthConnected": "{count, plural, one {# site Jira connecté.} other {# sites Jira connectés.}}"
}
```

- [ ] **Step 4: Server actions**

`apps/web/src/app/(app)/settings/jira/actions.ts`:
```ts
'use server';

import {
  createJiraConnection,
  deleteJiraConnection,
  ForbiddenError,
  retestJiraConnection,
} from '@agile/connections';
import type { JiraCredentials } from '@agile/jira';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { connectionDeps, requireActor } from '@/server/context';

export type FormState = { status: 'idle' } | { status: 'ok' } | { status: 'error'; code: string; message?: string };

const common = { name: z.string().trim().min(1).max(80), baseUrl: z.string().trim().min(1).max(500) };
const schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cloud_basic'), ...common, email: z.email(), apiToken: z.string().min(1).max(500) }),
  z.object({ kind: z.literal('datacenter_pat'), ...common, token: z.string().min(1).max(500) }),
]);

const PATH = '/settings/jira';

export async function createJiraConnectionAction(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await requireActor();
  const parsed = schema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { status: 'error', code: 'invalid_input' };
  const { name, ...rest } = parsed.data;
  const credentials: JiraCredentials =
    rest.kind === 'cloud_basic'
      ? { kind: 'cloud_basic', baseUrl: rest.baseUrl, email: rest.email, apiToken: rest.apiToken }
      : { kind: 'datacenter_pat', baseUrl: rest.baseUrl, token: rest.token };
  try {
    const result = await createJiraConnection(connectionDeps(), actor, { name, credentials });
    if (!result.ok) {
      // blocked_url carries an operator-facing reason worth showing; other codes map to translated text.
      return { status: 'error', code: result.code, message: result.code === 'blocked_url' ? result.message : undefined };
    }
  } catch (e) {
    if (e instanceof ForbiddenError) return { status: 'error', code: 'forbidden_role' };
    throw e;
  }
  revalidatePath(PATH);
  return { status: 'ok' };
}

export async function retestJiraConnectionAction(id: string): Promise<void> {
  const actor = await requireActor();
  await retestJiraConnection(connectionDeps(), actor, id);
  revalidatePath(PATH);
}

export async function deleteJiraConnectionAction(id: string): Promise<void> {
  const actor = await requireActor();
  await deleteJiraConnection(connectionDeps(), actor, id);
  revalidatePath(PATH);
}
```

- [ ] **Step 5: Form, connection item, and page (shadcn `field`, `radio-group`, `item`, `empty`, `sonner`)**

`apps/web/src/app/(app)/settings/jira/jira-connection-form.tsx`:
```tsx
'use client';

import { inferDeployment } from '@agile/jira';
import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { createJiraConnectionAction, type FormState } from './actions';

type Kind = 'cloud_basic' | 'datacenter_pat';

export function JiraConnectionForm({ oauthEnabled }: { oauthEnabled: boolean }) {
  const t = useTranslations('jira');
  const [state, action, pending] = useActionState<FormState, FormData>(createJiraConnectionAction, {
    status: 'idle',
  });
  const [kind, setKind] = useState<Kind>('cloud_basic');
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.status === 'ok') {
      formRef.current?.reset();
      toast.success(t('saved'));
    }
  }, [state, t]);

  const errorText =
    state.status === 'error'
      ? (state.message ?? (t.has(`errors.${state.code}`) ? t(`errors.${state.code}`) : t('errors.unknown')))
      : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('add')}</CardTitle>
        <CardDescription>{t('addDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form ref={formRef} action={action}>
          <FieldGroup>
            {oauthEnabled && (
              <>
                <Field>
                  {/* Full navigation (not next/link): the route redirects to Atlassian. */}
                  <Button asChild variant="outline">
                    <a href="/api/jira/oauth/start">{t('oauth')}</a>
                  </Button>
                </Field>
                <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">{t('or')}</FieldSeparator>
              </>
            )}
            <Field>
              <FieldLabel htmlFor="name">{t('name')}</FieldLabel>
              <Input id="name" name="name" required maxLength={80} />
            </Field>
            <Field>
              <FieldLabel htmlFor="baseUrl">{t('url')}</FieldLabel>
              <Input
                id="baseUrl"
                name="baseUrl"
                required
                placeholder="https://your-company.atlassian.net"
                onBlur={(e) => {
                  if (e.currentTarget.value) {
                    setKind(inferDeployment(e.currentTarget.value) === 'cloud' ? 'cloud_basic' : 'datacenter_pat');
                  }
                }}
              />
              <FieldDescription>{t('urlHint')}</FieldDescription>
            </Field>
            <FieldSet>
              <FieldLegend variant="label">{t('type')}</FieldLegend>
              <RadioGroup name="kind" value={kind} onValueChange={(v) => setKind(v as Kind)}>
                {(['cloud_basic', 'datacenter_pat'] as const).map((k) => (
                  <Field key={k} orientation="horizontal">
                    <RadioGroupItem value={k} id={`kind-${k}`} />
                    <FieldLabel htmlFor={`kind-${k}`} className="font-normal">
                      {k === 'cloud_basic' ? t('cloud') : t('datacenter')}
                    </FieldLabel>
                  </Field>
                ))}
              </RadioGroup>
            </FieldSet>
            {kind === 'cloud_basic' ? (
              <>
                <Field>
                  <FieldLabel htmlFor="email">{t('email')}</FieldLabel>
                  <Input id="email" name="email" type="email" required autoComplete="off" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="apiToken">{t('apiToken')}</FieldLabel>
                  <Input id="apiToken" name="apiToken" type="password" required autoComplete="off" />
                  <FieldDescription>{t('apiTokenHint')}</FieldDescription>
                </Field>
              </>
            ) : (
              <Field>
                <FieldLabel htmlFor="token">{t('pat')}</FieldLabel>
                <Input id="token" name="token" type="password" required autoComplete="off" />
                <FieldDescription>{t('patHint')}</FieldDescription>
              </Field>
            )}
            {errorText && <FieldError>{errorText}</FieldError>}
            <Field>
              <Button type="submit" disabled={pending}>
                {t('submit')}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
```

`apps/web/src/app/(app)/settings/jira/jira-connection-item.tsx`:
```tsx
import type { JiraConnectionView } from '@agile/connections';
import { Cloud, Server } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item';
import { deleteJiraConnectionAction, retestJiraConnectionAction } from './actions';

export async function JiraConnectionItem({ c, canManage }: { c: JiraConnectionView; canManage: boolean }) {
  const t = await getTranslations('jira');
  const status = { ok: t('connected'), error: t('failing'), untested: t('untested') }[c.status];
  const Icon = c.deployment === 'cloud' ? Cloud : Server;
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {c.name}
          <Badge variant={c.status === 'ok' ? 'default' : c.status === 'error' ? 'destructive' : 'secondary'}>
            {status}
          </Badge>
        </ItemTitle>
        <ItemDescription>
          {c.baseUrl}
          {c.accountName ? ` · ${c.accountName}` : ''}
        </ItemDescription>
        {c.lastError && (
          <p className="text-sm text-destructive">
            {t.has(`errors.${c.lastError}`) ? t(`errors.${c.lastError}`) : t('errors.unknown')}
          </p>
        )}
      </ItemContent>
      {canManage && (
        <ItemActions>
          <form action={retestJiraConnectionAction.bind(null, c.id)}>
            <Button variant="outline" size="sm">
              {t('retest')}
            </Button>
          </form>
          <form action={deleteJiraConnectionAction.bind(null, c.id)}>
            <Button variant="ghost" size="sm">
              {t('delete')}
            </Button>
          </form>
        </ItemActions>
      )}
    </Item>
  );
}
```

`apps/web/src/app/(app)/settings/jira/page.tsx`:
```tsx
import { canManageConnections } from '@agile/auth';
import { listJiraConnections } from '@agile/connections';
import { PlugZap } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { ItemGroup } from '@/components/ui/item';
import { connectionDeps, requireActor, services } from '@/server/context';
import { JiraConnectionForm } from './jira-connection-form';
import { JiraConnectionItem } from './jira-connection-item';

export default async function JiraSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const actor = await requireActor();
  const t = await getTranslations('jira');
  const { connected, error } = await searchParams;
  const connections = await listJiraConnections(connectionDeps(), actor.orgId);
  const canManage = canManageConnections(actor.roles);

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>
      {connected && (
        <Alert>
          <AlertDescription>{t('oauthConnected', { count: Number(connected) })}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{t.has(`errors.${error}`) ? t(`errors.${error}`) : t('errors.unknown')}</AlertDescription>
        </Alert>
      )}
      {connections.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PlugZap />
            </EmptyMedia>
            <EmptyTitle>{t('empty')}</EmptyTitle>
            <EmptyDescription>{t('emptyHint')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="gap-3">
          {connections.map((c) => (
            <JiraConnectionItem key={c.id} c={c} canManage={canManage} />
          ))}
        </ItemGroup>
      )}
      {canManage ? (
        <JiraConnectionForm oauthEnabled={Boolean(services().env.ATLASSIAN_OAUTH_CLIENT_ID)} />
      ) : (
        <p className="text-sm text-muted-foreground">{t('readOnlyNotice')}</p>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Run e2e**

Run: `pnpm e2e --grep "Jira"`
Expected: 2 PASS. The pasted `/browse/ABC-1` link is shown as `http://127.0.0.1:4010`, and the token with surrounding spaces works.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): Jira connection settings with test-before-save"
```

---

### Task 11: "Connect with Atlassian" (OAuth 2.0 3LO) and token refresh

**Files:**
- Create: `packages/jira/src/oauth.ts`; Modify: `packages/jira/src/index.ts`
- Create: `packages/connections/src/jira-oauth.ts`; Modify: `packages/connections/src/index.ts`
- Create: `apps/web/src/app/api/jira/oauth/start/route.ts`, `apps/web/src/app/api/jira/oauth/callback/route.ts`, `apps/web/src/server/atlassian.ts`
- Test: `packages/jira/src/oauth.test.ts`, `packages/connections/src/jira-oauth.test.ts`

**Interfaces:**
- Consumes: `ConnectionDeps`, `StoredJiraSecret`, `createJiraConnection`, `readSecret`, `writeSecret`, `recordAudit`, `Actor` (Task 7); `JiraCredentials` (Task 5).
- Produces (`@agile/jira`):
  - `ATLASSIAN_SCOPES: readonly string[]`
  - `interface AtlassianTokens { accessToken(): string; refreshToken(): string; accessTokenExpiresAt(): Date }`
  - `interface AtlassianOAuthClient { createAuthorizationURL(state: string, scopes: string[]): URL; validateAuthorizationCode(code: string): Promise<AtlassianTokens>; refreshAccessToken(refreshToken: string): Promise<AtlassianTokens> }`
  - `createAtlassianOAuth(cfg: { clientId: string; clientSecret: string; redirectUri: string }): AtlassianOAuthClient`
  - `interface AtlassianSite { id: string; url: string; name: string }`
  - `listAccessibleJiraSites(accessToken: string, opts?: { apiBase?: string }): Promise<AtlassianSite[]>`
- Produces (`@agile/connections`):
  - `completeJiraOAuth(deps: ConnectionDeps & { oauth: AtlassianOAuthClient; listSites?: typeof listAccessibleJiraSites }, actor: Actor, code: string): Promise<{ ok: true; created: number } | { ok: false; code: 'oauth_failed' | 'oauth_no_sites' }>`
  - `getFreshJiraCredentials(deps: ConnectionDeps & { oauth: AtlassianOAuthClient }, orgId: string, id: string, now?: () => Date): Promise<JiraCredentials | null>` — refreshes when the token expires within 60 s; serialised per connection with `SELECT … FOR UPDATE`.

- [ ] **Step 1: Write failing tests for site discovery**

`packages/jira/src/oauth.test.ts`:
```ts
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAccessibleJiraSites } from './oauth';

describe('listAccessibleJiraSites', () => {
  let base = '';
  const server = createServer((req, res) => {
    if (req.url !== '/oauth/token/accessible-resources' || req.headers.authorization !== 'Bearer at-1') {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify([
        { id: 'c-1', url: 'https://acme.atlassian.net', name: 'acme', scopes: ['read:jira-work', 'write:jira-work'] },
        { id: 'c-2', url: 'https://acme-wiki.atlassian.net', name: 'wiki', scopes: ['read:confluence-content.all'] },
      ]),
    );
  });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('returns only sites granted Jira scopes', async () => {
    expect(await listAccessibleJiraSites('at-1', { apiBase: base })).toEqual([
      { id: 'c-1', url: 'https://acme.atlassian.net', name: 'acme' },
    ]);
  });

  it('throws on a rejected token', async () => {
    await expect(listAccessibleJiraSites('bad', { apiBase: base })).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Implement**

`packages/jira/src/oauth.ts`:
```ts
import { Atlassian } from 'arctic';
import { z } from 'zod';

/** Classic Jira scopes + Jira Software (agile) granular scopes needed for boards/sprints in Phase 2. */
export const ATLASSIAN_SCOPES = [
  'read:jira-work',
  'read:jira-user',
  'write:jira-work',
  'read:board-scope:jira-software',
  'read:sprint:jira-software',
  'offline_access',
] as const;

export interface AtlassianTokens {
  accessToken(): string;
  refreshToken(): string;
  accessTokenExpiresAt(): Date;
}

export interface AtlassianOAuthClient {
  createAuthorizationURL(state: string, scopes: string[]): URL;
  validateAuthorizationCode(code: string): Promise<AtlassianTokens>;
  refreshAccessToken(refreshToken: string): Promise<AtlassianTokens>;
}

export function createAtlassianOAuth(cfg: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): AtlassianOAuthClient {
  return new Atlassian(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
}

export interface AtlassianSite {
  id: string;
  url: string;
  name: string;
}

const resources = z.array(
  z.object({ id: z.string(), url: z.string(), name: z.string(), scopes: z.array(z.string()).default([]) }),
);

export async function listAccessibleJiraSites(
  accessToken: string,
  opts: { apiBase?: string } = {},
): Promise<AtlassianSite[]> {
  const res = await fetch(`${opts.apiBase ?? 'https://api.atlassian.com'}/oauth/token/accessible-resources`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`accessible-resources failed with HTTP ${res.status}`);
  return resources
    .parse(await res.json())
    .filter((s) => s.scopes.some((scope) => scope.endsWith(':jira-work')))
    .map(({ id, url, name }) => ({ id, url, name }));
}
```

Append to `packages/jira/src/index.ts`:
```ts
export {
  ATLASSIAN_SCOPES,
  type AtlassianOAuthClient,
  type AtlassianSite,
  type AtlassianTokens,
  createAtlassianOAuth,
  listAccessibleJiraSites,
} from './oauth';
```

Run: `pnpm vitest run --project jira src/oauth.test.ts` — Expected: PASS.

- [ ] **Step 3: Write failing tests for OAuth completion and refresh**

`packages/connections/src/jira-oauth.test.ts`:
```ts
import type { AtlassianOAuthClient, AtlassianTokens } from '@agile/jira';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { listJiraConnections, loadJiraSecret } from './jira-connections';
import { completeJiraOAuth, getFreshJiraCredentials } from './jira-oauth';
import { keyring, okJira, owner, startHarness } from './test-helpers';

const tokens = (n: number, expiresAt: Date): AtlassianTokens => ({
  accessToken: () => `access-${n}`,
  refreshToken: () => `refresh-${n}`,
  accessTokenExpiresAt: () => expiresAt,
});

describe('Atlassian OAuth', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  const soon = new Date(Date.now() + 30_000); // expires within the 60 s refresh window
  const later = new Date(Date.now() + 3_600_000);
  let refreshCalls = 0;
  const oauth: AtlassianOAuthClient = {
    createAuthorizationURL: () => new URL('https://auth.atlassian.com/authorize'),
    validateAuthorizationCode: async (code) => {
      if (code !== 'good-code') throw new Error('invalid_grant');
      return tokens(1, soon);
    },
    refreshAccessToken: async (rt) => {
      refreshCalls++;
      await new Promise((r) => setTimeout(r, 50));
      if (rt !== 'refresh-1') throw new Error('refresh token reused');
      return tokens(2, later);
    },
  };

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => h?.stop());

  const deps = () => ({
    db: h.db,
    keyring,
    allowedPrivateHosts: [],
    testJira: okJira('Pat Cloud'),
    oauth,
    listSites: vi.fn(async () => [{ id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme' }]),
  });

  it('creates one connection per Jira site with encrypted tokens', async () => {
    expect(await completeJiraOAuth(deps(), owner(), 'good-code')).toEqual({ ok: true, created: 1 });
    const [c] = await listJiraConnections(deps(), 'org_a');
    expect(c).toMatchObject({ authType: 'oauth', deployment: 'cloud', baseUrl: 'https://acme.atlassian.net' });
    const secret = await loadJiraSecret(deps(), 'org_a', c?.id ?? '');
    expect(secret).toMatchObject({
      credentials: { kind: 'cloud_oauth', cloudId: 'cloud-1', accessToken: 'access-1' },
      oauth: { refreshToken: 'refresh-1' },
    });
  });

  it('reports a failed code exchange and accounts without Jira sites', async () => {
    expect(await completeJiraOAuth(deps(), owner(), 'bad')).toEqual({ ok: false, code: 'oauth_failed' });
    const noSites = { ...deps(), listSites: vi.fn(async () => []) };
    expect(await completeJiraOAuth(noSites, owner('org_c'), 'good-code')).toEqual({
      ok: false,
      code: 'oauth_no_sites',
    });
  });

  it('refreshes an expiring token exactly once under concurrency and persists the rotated token', async () => {
    const [c] = await listJiraConnections(deps(), 'org_a');
    const id = c?.id ?? '';
    const [a, b] = await Promise.all([
      getFreshJiraCredentials(deps(), 'org_a', id),
      getFreshJiraCredentials(deps(), 'org_a', id),
    ]);
    expect(refreshCalls).toBe(1);
    expect(a).toMatchObject({ kind: 'cloud_oauth', accessToken: 'access-2' });
    expect(b).toMatchObject({ kind: 'cloud_oauth', accessToken: 'access-2' });
    expect((await loadJiraSecret(deps(), 'org_a', id))?.oauth?.refreshToken).toBe('refresh-2');
  });

  it('returns null for another org', async () => {
    const [c] = await listJiraConnections(deps(), 'org_a');
    expect(await getFreshJiraCredentials(deps(), 'org_b', c?.id ?? '')).toBeNull();
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `pnpm vitest run --project connections src/jira-oauth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement**

`packages/connections/src/jira-oauth.ts`:
```ts
import { jiraConnections, withOrg } from '@agile/db';
import {
  type AtlassianOAuthClient,
  type JiraCredentials,
  listAccessibleJiraSites,
} from '@agile/jira';
import { eq } from 'drizzle-orm';
import type { Actor } from './actor';
import { assertCanManage } from './actor';
import { recordAudit } from './audit';
import { type ConnectionDeps, createJiraConnection, readSecret, writeSecret } from './jira-connections';

type OAuthDeps = ConnectionDeps & {
  oauth: AtlassianOAuthClient;
  listSites?: typeof listAccessibleJiraSites;
};

const REFRESH_WINDOW_MS = 60_000;

export async function completeJiraOAuth(
  deps: OAuthDeps,
  actor: Actor,
  code: string,
): Promise<{ ok: true; created: number } | { ok: false; code: 'oauth_failed' | 'oauth_no_sites' }> {
  assertCanManage(actor);
  let tokens: Awaited<ReturnType<AtlassianOAuthClient['validateAuthorizationCode']>>;
  let sites: Awaited<ReturnType<typeof listAccessibleJiraSites>>;
  try {
    tokens = await deps.oauth.validateAuthorizationCode(code);
    sites = await (deps.listSites ?? listAccessibleJiraSites)(tokens.accessToken());
  } catch {
    return { ok: false, code: 'oauth_failed' };
  }
  if (sites.length === 0) return { ok: false, code: 'oauth_no_sites' };

  let created = 0;
  for (const site of sites) {
    const result = await createJiraConnection(deps, actor, {
      name: site.name,
      credentials: { kind: 'cloud_oauth', baseUrl: site.url, cloudId: site.id, accessToken: tokens.accessToken() },
      oauth: { refreshToken: tokens.refreshToken(), expiresAt: tokens.accessTokenExpiresAt().toISOString() },
    });
    if (result.ok) created++;
  }
  return { ok: true, created };
}

/**
 * Returns usable credentials, refreshing an expiring OAuth token first. Atlassian rotates refresh
 * tokens, so refreshes are serialised per connection with a row lock; later callers see the new token.
 */
export async function getFreshJiraCredentials(
  deps: OAuthDeps,
  orgId: string,
  id: string,
  now: () => Date = () => new Date(),
): Promise<JiraCredentials | null> {
  return withOrg(deps.db, orgId, async (tx) => {
    const [row] = await tx.select().from(jiraConnections).where(eq(jiraConnections.id, id)).for('update');
    if (!row) return null;
    const secret = await readSecret(tx, deps, orgId, id, row.secret);
    if (secret.credentials.kind !== 'cloud_oauth' || !secret.oauth) return secret.credentials;
    if (new Date(secret.oauth.expiresAt).getTime() - now().getTime() > REFRESH_WINDOW_MS) {
      return secret.credentials;
    }

    const tokens = await deps.oauth.refreshAccessToken(secret.oauth.refreshToken);
    const credentials: JiraCredentials = { ...secret.credentials, accessToken: tokens.accessToken() };
    const encrypted = await writeSecret(tx, deps, orgId, id, {
      credentials,
      oauth: { refreshToken: tokens.refreshToken(), expiresAt: tokens.accessTokenExpiresAt().toISOString() },
    });
    await tx.update(jiraConnections).set({ secret: encrypted }).where(eq(jiraConnections.id, id));
    await recordAudit(tx, {
      orgId,
      actorUserId: null,
      action: 'jira_connection.token_refreshed',
      targetType: 'jira_connection',
      targetId: id,
    });
    return credentials;
  });
}
```

Append to `packages/connections/src/index.ts`:
```ts
export { completeJiraOAuth, getFreshJiraCredentials } from './jira-oauth';
```

Note: `readSecret`/`writeSecret` are already exported from `jira-connections.ts` (Task 7) but not from the package index — they stay internal.

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run --project connections && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Route handlers**

`apps/web/src/server/atlassian.ts`:
```ts
import 'server-only';
import { createAtlassianOAuth } from '@agile/jira';
import { services } from './context';

export const OAUTH_STATE_COOKIE = 'jira_oauth_state';

export function atlassianOAuth() {
  const { env } = services();
  if (!env.ATLASSIAN_OAUTH_CLIENT_ID || !env.ATLASSIAN_OAUTH_CLIENT_SECRET) return null;
  return createAtlassianOAuth({
    clientId: env.ATLASSIAN_OAUTH_CLIENT_ID,
    clientSecret: env.ATLASSIAN_OAUTH_CLIENT_SECRET,
    redirectUri: new URL('/api/jira/oauth/callback', env.BETTER_AUTH_URL).toString(),
  });
}
```

`apps/web/src/app/api/jira/oauth/start/route.ts`:
```ts
import { canManageConnections } from '@agile/auth';
import { ATLASSIAN_SCOPES } from '@agile/jira';
import { generateState } from 'arctic';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { atlassianOAuth, OAUTH_STATE_COOKIE } from '@/server/atlassian';
import { requireActor, services } from '@/server/context';

export async function GET() {
  const actor = await requireActor();
  const back = new URL('/settings/jira', services().env.BETTER_AUTH_URL);
  const oauth = atlassianOAuth();
  if (!oauth || !canManageConnections(actor.roles)) {
    back.searchParams.set('error', oauth ? 'forbidden_role' : 'oauth_failed');
    return NextResponse.redirect(back);
  }
  const state = generateState();
  (await cookies()).set(OAUTH_STATE_COOKIE, `${state}.${actor.orgId}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/jira/oauth',
    maxAge: 600,
  });
  return NextResponse.redirect(oauth.createAuthorizationURL(state, [...ATLASSIAN_SCOPES]));
}
```

`apps/web/src/app/api/jira/oauth/callback/route.ts`:
```ts
import { completeJiraOAuth } from '@agile/connections';
import { cookies } from 'next/headers';
import { type NextRequest, NextResponse } from 'next/server';
import { atlassianOAuth, OAUTH_STATE_COOKIE } from '@/server/atlassian';
import { connectionDeps, requireActor, services } from '@/server/context';

export async function GET(request: NextRequest) {
  const actor = await requireActor();
  const back = new URL('/settings/jira', services().env.BETTER_AUTH_URL);
  const jar = await cookies();
  const stored = jar.get(OAUTH_STATE_COOKIE)?.value ?? '';
  jar.delete({ name: OAUTH_STATE_COOKIE, path: '/api/jira/oauth' });

  const [state, orgId] = stored.split('.');
  const code = request.nextUrl.searchParams.get('code');
  const oauth = atlassianOAuth();
  // Reject forged callbacks, and flows started in a different workspace than the active one.
  if (!oauth || !code || !state || state !== request.nextUrl.searchParams.get('state') || orgId !== actor.orgId) {
    back.searchParams.set('error', 'oauth_failed');
    return NextResponse.redirect(back);
  }

  const result = await completeJiraOAuth({ ...connectionDeps(), oauth }, actor, code);
  if (result.ok) back.searchParams.set('connected', String(result.created));
  else back.searchParams.set('error', result.code);
  return NextResponse.redirect(back);
}
```

Add `"arctic": "3.7.0"` to `apps/web/package.json` dependencies, then `pnpm install`.

- [ ] **Step 8: Manual verification against real Atlassian (one-time, documented in README in Task 13)**

1. In developer.atlassian.com → Create → OAuth 2.0 integration; add callback `http://localhost:3000/api/jira/oauth/callback`; under Permissions add Jira API scopes `read:jira-work`, `read:jira-user`, `write:jira-work` and Jira Software scopes `read:board-scope:jira-software`, `read:sprint:jira-software`.
2. Put the client id/secret in `.env`, run `pnpm dev`, click **Connect with Atlassian**.
Expected: redirected back to `/settings/jira?connected=1`, connection shows **Connected** with your Atlassian display name. If Atlassian rejects the scope mix, record the error and keep only classic scopes (Phase 2 re-checks agile endpoints).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(jira): Connect with Atlassian (OAuth 3LO) with serialized token refresh"
```

---

### Task 12: LLM connection settings

**Files:**
- Create: `apps/web/src/app/(app)/settings/llm/{page.tsx,actions.ts,llm-connection-form.tsx,llm-connection-item.tsx}`
- Modify: `apps/web/messages/{en,fr}.json` (add `llm` namespace)
- Test: `e2e/tests/llm-connection.spec.ts`

**Interfaces:**
- Consumes: `createLlmConnection`, `listLlmConnections`, `retestLlmConnection`, `deleteLlmConnection`, `setDefaultLlmConnection`, `ForbiddenError` (Tasks 7–8); `LLM_PROVIDERS`, `LlmConfig` (Task 6); `requireActor`, `connectionDeps` (Task 9); `FormState` shape (Task 10, redeclared locally).
- Produces: server actions `createLlmConnectionAction(prev, form)`, `retestLlmConnectionAction(id)`, `deleteLlmConnectionAction(id)`, `setDefaultLlmConnectionAction(id)`.

- [ ] **Step 1: Write the failing e2e test**

`e2e/tests/llm-connection.spec.ts`:
```ts
import { expect, test } from '@playwright/test';
import { connectionItem, signUpWithWorkspace } from '../helpers';

test('connect an OpenAI-compatible model with your own key', async ({ page }) => {
  await signUpWithWorkspace(page);
  await page.getByRole('link', { name: 'AI model' }).click();

  await page.getByLabel('Provider').selectOption('openai_compatible');
  await page.getByLabel('Label').fill('Local model');
  await page.getByLabel('Model').fill('mock');
  await page.getByLabel('Base URL').fill('http://127.0.0.1:4020/v1');
  await page.getByLabel('API key').fill('wrong-key');
  await page.getByRole('button', { name: 'Test and save' }).click();
  await expect(page.getByText('The provider rejected this API key.')).toBeVisible();

  await page.getByLabel('API key').fill('good-key');
  await page.getByRole('button', { name: 'Test and save' }).click();
  const card = connectionItem(page, 'Local model');
  await expect(card.getByText('Connected')).toBeVisible();
  await expect(card.getByText('Default')).toBeVisible();
  await expect(page.getByText('good-key')).toHaveCount(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm e2e --grep "OpenAI-compatible"`
Expected: FAIL — page not found.

- [ ] **Step 3: Messages**

Add to `apps/web/messages/en.json`:
```json
"llm": {
  "title": "AI model",
  "intro": "Bring your own key. It is encrypted and only used to answer your workspace's questions.",
  "empty": "No AI model connected yet.",
  "emptyHint": "Add a key from Anthropic, OpenAI, Google, Azure, Mistral or a local model server.",
  "saved": "AI model connected.",
  "add": "Add a model",
  "provider": "Provider",
  "providers": {
    "anthropic": "Anthropic (Claude)",
    "openai": "OpenAI",
    "google": "Google (Gemini)",
    "azure": "Azure OpenAI",
    "mistral": "Mistral",
    "openai_compatible": "OpenAI-compatible (Ollama, vLLM, LM Studio…)"
  },
  "label": "Label",
  "model": "Model",
  "modelHint": "The model id from your provider, e.g. claude-sonnet-5-5. For Azure, the deployment name.",
  "baseUrl": "Base URL",
  "resourceName": "Azure resource name",
  "apiKey": "API key",
  "apiKeyOptional": "API key (optional)",
  "submit": "Test and save",
  "default": "Default",
  "makeDefault": "Make default",
  "connected": "Connected",
  "failing": "Failing",
  "untested": "Not tested",
  "retest": "Test again",
  "delete": "Remove",
  "readOnlyNotice": "Only workspace owners and admins can change connections.",
  "errors": {
    "invalid_input": "Check the fields.",
    "blocked_url": "This address is private. Ask your administrator to allow it.",
    "unauthorized": "The provider rejected this API key.",
    "forbidden": "This key is not allowed to use this model.",
    "model_not_found": "The provider does not know this model name.",
    "rate_limited": "The provider is rate limiting this key, or it has no credit left.",
    "no_tool_calling": "This model can't use tools, which the assistant needs. Pick another model.",
    "unreachable": "Could not reach the provider.",
    "provider_error": "The provider returned an error.",
    "not_found": "Connection not found.",
    "forbidden_role": "Only workspace owners and admins can change connections.",
    "unknown": "Something went wrong."
  }
}
```

Add the French equivalent to `apps/web/messages/fr.json`:
```json
"llm": {
  "title": "Modèle d'IA",
  "intro": "Utilisez votre propre clé. Elle est chiffrée et sert uniquement à répondre aux questions de votre espace.",
  "empty": "Aucun modèle d'IA connecté pour l'instant.",
  "emptyHint": "Ajoutez une clé Anthropic, OpenAI, Google, Azure, Mistral ou un serveur de modèles local.",
  "saved": "Modèle d'IA connecté.",
  "add": "Ajouter un modèle",
  "provider": "Fournisseur",
  "providers": {
    "anthropic": "Anthropic (Claude)",
    "openai": "OpenAI",
    "google": "Google (Gemini)",
    "azure": "Azure OpenAI",
    "mistral": "Mistral",
    "openai_compatible": "Compatible OpenAI (Ollama, vLLM, LM Studio…)"
  },
  "label": "Libellé",
  "model": "Modèle",
  "modelHint": "L'identifiant du modèle chez votre fournisseur, par ex. claude-sonnet-5-5. Pour Azure, le nom du déploiement.",
  "baseUrl": "URL de base",
  "resourceName": "Nom de la ressource Azure",
  "apiKey": "Clé d'API",
  "apiKeyOptional": "Clé d'API (facultative)",
  "submit": "Tester et enregistrer",
  "default": "Par défaut",
  "makeDefault": "Définir par défaut",
  "connected": "Connecté",
  "failing": "En erreur",
  "untested": "Non testé",
  "retest": "Tester à nouveau",
  "delete": "Supprimer",
  "readOnlyNotice": "Seuls les propriétaires et administrateurs peuvent modifier les connexions.",
  "errors": {
    "invalid_input": "Vérifiez les champs.",
    "blocked_url": "Cette adresse est privée. Demandez à votre administrateur de l'autoriser.",
    "unauthorized": "Le fournisseur a refusé cette clé d'API.",
    "forbidden": "Cette clé n'a pas accès à ce modèle.",
    "model_not_found": "Le fournisseur ne connaît pas ce modèle.",
    "rate_limited": "Le fournisseur limite cette clé, ou le crédit est épuisé.",
    "no_tool_calling": "Ce modèle ne sait pas utiliser d'outils, nécessaires à l'assistant. Choisissez-en un autre.",
    "unreachable": "Impossible de joindre le fournisseur.",
    "provider_error": "Le fournisseur a renvoyé une erreur.",
    "not_found": "Connexion introuvable.",
    "forbidden_role": "Seuls les propriétaires et administrateurs peuvent modifier les connexions.",
    "unknown": "Une erreur est survenue."
  }
}
```

- [ ] **Step 4: Server actions**

`apps/web/src/app/(app)/settings/llm/actions.ts`:
```ts
'use server';

import {
  createLlmConnection,
  deleteLlmConnection,
  ForbiddenError,
  retestLlmConnection,
  setDefaultLlmConnection,
} from '@agile/connections';
import type { LlmConfig } from '@agile/llm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { connectionDeps, requireActor } from '@/server/context';

export type FormState = { status: 'idle' } | { status: 'ok' } | { status: 'error'; code: string; message?: string };

const common = { label: z.string().trim().min(1).max(80), model: z.string().trim().min(1).max(200) };
const key = z.string().trim().min(1).max(1000);
const schema = z.discriminatedUnion('provider', [
  z.object({ provider: z.enum(['anthropic', 'openai', 'google', 'mistral']), ...common, apiKey: key }),
  z.object({ provider: z.literal('azure'), ...common, apiKey: key, resourceName: z.string().trim().min(1).max(100) }),
  z.object({
    provider: z.literal('openai_compatible'),
    ...common,
    baseUrl: z.string().trim().min(1).max(500),
    apiKey: z.string().trim().max(1000).optional(),
  }),
]);

const PATH = '/settings/llm';

export async function createLlmConnectionAction(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await requireActor();
  const parsed = schema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { status: 'error', code: 'invalid_input' };
  const { label, ...config } = parsed.data;
  try {
    const result = await createLlmConnection(connectionDeps(), actor, { label, config: config as LlmConfig });
    if (!result.ok) {
      return { status: 'error', code: result.code, message: result.code === 'blocked_url' ? result.message : undefined };
    }
  } catch (e) {
    if (e instanceof ForbiddenError) return { status: 'error', code: 'forbidden_role' };
    throw e;
  }
  revalidatePath(PATH);
  return { status: 'ok' };
}

export async function retestLlmConnectionAction(id: string) {
  await retestLlmConnection(connectionDeps(), await requireActor(), id);
  revalidatePath(PATH);
}

export async function deleteLlmConnectionAction(id: string) {
  await deleteLlmConnection(connectionDeps(), await requireActor(), id);
  revalidatePath(PATH);
}

export async function setDefaultLlmConnectionAction(id: string) {
  await setDefaultLlmConnection(connectionDeps(), await requireActor(), id);
  revalidatePath(PATH);
}
```

- [ ] **Step 5: Form, connection item, and page (shadcn `field`, `native-select`, `item`, `empty`, `sonner`)**

`apps/web/src/app/(app)/settings/llm/llm-connection-form.tsx`:
```tsx
'use client';

import { LLM_PROVIDERS, type LlmProvider } from '@agile/llm';
import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { createLlmConnectionAction, type FormState } from './actions';

export function LlmConnectionForm() {
  const t = useTranslations('llm');
  const [state, action, pending] = useActionState<FormState, FormData>(createLlmConnectionAction, { status: 'idle' });
  const [provider, setProvider] = useState<LlmProvider>('anthropic');
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.status === 'ok') {
      formRef.current?.reset();
      toast.success(t('saved'));
    }
  }, [state, t]);

  const errorText =
    state.status === 'error'
      ? (state.message ?? (t.has(`errors.${state.code}`) ? t(`errors.${state.code}`) : t('errors.unknown')))
      : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('add')}</CardTitle>
        <CardDescription>{t('intro')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form ref={formRef} action={action}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="provider">{t('provider')}</FieldLabel>
              <NativeSelect
                id="provider"
                name="provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value as LlmProvider)}
              >
                {LLM_PROVIDERS.map((p) => (
                  <NativeSelectOption key={p} value={p}>
                    {t(`providers.${p}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="label">{t('label')}</FieldLabel>
              <Input id="label" name="label" required maxLength={80} />
            </Field>
            <Field>
              <FieldLabel htmlFor="model">{t('model')}</FieldLabel>
              <Input id="model" name="model" required placeholder={provider === 'anthropic' ? 'claude-sonnet-5-5' : ''} />
              <FieldDescription>{t('modelHint')}</FieldDescription>
            </Field>
            {provider === 'azure' && (
              <Field>
                <FieldLabel htmlFor="resourceName">{t('resourceName')}</FieldLabel>
                <Input id="resourceName" name="resourceName" required />
              </Field>
            )}
            {provider === 'openai_compatible' && (
              <Field>
                <FieldLabel htmlFor="baseUrl">{t('baseUrl')}</FieldLabel>
                <Input id="baseUrl" name="baseUrl" required placeholder="http://ollama:11434/v1" />
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="apiKey">
                {provider === 'openai_compatible' ? t('apiKeyOptional') : t('apiKey')}
              </FieldLabel>
              <Input
                id="apiKey"
                name="apiKey"
                type="password"
                autoComplete="off"
                required={provider !== 'openai_compatible'}
              />
            </Field>
            {errorText && <FieldError>{errorText}</FieldError>}
            <Field>
              <Button type="submit" disabled={pending}>
                {t('submit')}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
```

`apps/web/src/app/(app)/settings/llm/llm-connection-item.tsx`:
```tsx
import type { LlmConnectionView } from '@agile/connections';
import { Bot } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item';
import { deleteLlmConnectionAction, retestLlmConnectionAction, setDefaultLlmConnectionAction } from './actions';

export async function LlmConnectionItem({ c, canManage }: { c: LlmConnectionView; canManage: boolean }) {
  const t = await getTranslations('llm');
  const status = { ok: t('connected'), error: t('failing'), untested: t('untested') }[c.status];
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        <Bot />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {c.label}
          <Badge variant={c.status === 'ok' ? 'default' : c.status === 'error' ? 'destructive' : 'secondary'}>
            {status}
          </Badge>
          {c.isDefault && <Badge variant="outline">{t('default')}</Badge>}
        </ItemTitle>
        <ItemDescription>
          {t(`providers.${c.provider}`)} · {c.model}
          {c.keyHint ? ` · ${c.keyHint}` : ''}
        </ItemDescription>
        {c.lastError && (
          <p className="text-sm text-destructive">
            {t.has(`errors.${c.lastError}`) ? t(`errors.${c.lastError}`) : t('errors.unknown')}
          </p>
        )}
      </ItemContent>
      {canManage && (
        <ItemActions className="flex-wrap">
          {!c.isDefault && (
            <form action={setDefaultLlmConnectionAction.bind(null, c.id)}>
              <Button variant="outline" size="sm">
                {t('makeDefault')}
              </Button>
            </form>
          )}
          <form action={retestLlmConnectionAction.bind(null, c.id)}>
            <Button variant="outline" size="sm">
              {t('retest')}
            </Button>
          </form>
          <form action={deleteLlmConnectionAction.bind(null, c.id)}>
            <Button variant="ghost" size="sm">
              {t('delete')}
            </Button>
          </form>
        </ItemActions>
      )}
    </Item>
  );
}
```

`apps/web/src/app/(app)/settings/llm/page.tsx`:
```tsx
import { canManageConnections } from '@agile/auth';
import { listLlmConnections } from '@agile/connections';
import { Bot } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { ItemGroup } from '@/components/ui/item';
import { connectionDeps, requireActor } from '@/server/context';
import { LlmConnectionForm } from './llm-connection-form';
import { LlmConnectionItem } from './llm-connection-item';

export default async function LlmSettingsPage() {
  const actor = await requireActor();
  const t = await getTranslations('llm');
  const connections = await listLlmConnections(connectionDeps(), actor.orgId);
  const canManage = canManageConnections(actor.roles);
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground">{t('intro')}</p>
      </div>
      {connections.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Bot />
            </EmptyMedia>
            <EmptyTitle>{t('empty')}</EmptyTitle>
            <EmptyDescription>{t('emptyHint')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="gap-3">
          {connections.map((c) => (
            <LlmConnectionItem key={c.id} c={c} canManage={canManage} />
          ))}
        </ItemGroup>
      )}
      {canManage ? <LlmConnectionForm /> : <p className="text-sm text-muted-foreground">{t('readOnlyNotice')}</p>}
    </div>
  );
}
```

- [ ] **Step 6: Run e2e and full suite**

Run: `pnpm e2e && pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): BYOK AI model settings with tool-calling check"
```

---

### Task 13: Self-host packaging, README, and CI e2e

**Files:**
- Create: `apps/web/Dockerfile`, `.dockerignore`, `docker-compose.selfhost.yml`, `README.md`
- Modify: `.github/workflows/ci.yml` (add e2e job)

**Interfaces:**
- Consumes: everything above. Produces: images `agile-web` (target `runner`) and `agile-migrate` (target `migrate`).

- [ ] **Step 1: Dockerfile (Next standalone + migration image)**

`apps/web/Dockerfile`:
```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
COPY packages/ packages/
RUN find packages -type f ! -name package.json -delete
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @agile/web build

FROM base AS migrate
COPY --from=build /repo /repo
CMD ["pnpm", "db:migrate"]

FROM node:24-alpine AS runner
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /repo/apps/web/.next/standalone ./
COPY --from=build --chown=app:app /repo/apps/web/.next/static ./apps/web/.next/static
USER app
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
```

`.dockerignore`:
```
**/node_modules
**/.next
**/.turbo
.git
.env
playwright-report
test-results
```

- [ ] **Step 2: Self-host compose**

`docker-compose.selfhost.yml`:
```yaml
# Usage: cp .env.example .env (fill secrets), then: docker compose -f docker-compose.selfhost.yml up -d
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: agile
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}
      POSTGRES_DB: agile
      APP_DB_PASSWORD: ${APP_DB_PASSWORD:?set APP_DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./docker/postgres/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U agile -d agile"]
      interval: 2s
      retries: 30
  migrate:
    build: { context: ., dockerfile: apps/web/Dockerfile, target: migrate }
    environment:
      DATABASE_OWNER_URL: postgres://agile:${POSTGRES_PASSWORD}@postgres:5432/agile
    depends_on: { postgres: { condition: service_healthy } }
  web:
    build: { context: ., dockerfile: apps/web/Dockerfile, target: runner }
    env_file: .env
    environment:
      DATABASE_URL: postgres://app_user:${APP_DB_PASSWORD}@postgres:5432/agile
    ports: ["3000:3000"]
    depends_on: { migrate: { condition: service_completed_successfully } }
volumes:
  pgdata:
```

Add to `.env.example`:
```bash
# Self-host compose only
POSTGRES_PASSWORD=
APP_DB_PASSWORD=
```

- [ ] **Step 3: Verify self-host from a clean state**

Run:
```bash
docker compose down -v
cp .env.example .env   # fill BETTER_AUTH_SECRET, ENCRYPTION_KEYS=v1:$(openssl rand -base64 32), POSTGRES_PASSWORD, APP_DB_PASSWORD
docker compose -f docker-compose.selfhost.yml up -d --build
```
Expected: `migrate` exits 0, `web` is healthy, `http://localhost:3000` redirects to `/login`, and sign-up → workspace works in a browser.

- [ ] **Step 4: README**

`README.md` sections (write real prose for each):
1. **What it is** — one paragraph from the spec's Context.
2. **Quick start (development)** — `pnpm install`, `docker compose up -d postgres`, `cp .env.example .env` + generate secrets (`openssl rand -base64 32` for `BETTER_AUTH_SECRET`; `ENCRYPTION_KEYS=v1:$(openssl rand -base64 32)`), `pnpm db:migrate`, `pnpm dev`.
3. **Self-hosting** — Step 2–3 commands; `ALLOWED_PRIVATE_HOSTS` for internal Jira/Ollama hostnames; never expose Postgres publicly.
4. **Connect with Atlassian (optional)** — Task 11 Step 8 instructions verbatim, with the production callback URL `https://<your-domain>/api/jira/oauth/callback`.
5. **Rotating the encryption key** — append `v2:<new key>` to `ENCRYPTION_KEYS` and restart; new org keys use v2, old ones still decrypt with v1; keep v1 until a future re-wrap command exists (Phase 5).
6. **Security model** — RLS + `app_user`, per-org DEKs, audit log, test-before-save, outbound URL guard.
7. **Development** — `pnpm test`, `pnpm e2e`, `pnpm lint`, `pnpm typecheck`; Docker is required for tests (Testcontainers).

- [ ] **Step 5: CI e2e job**

Append to `.github/workflows/ci.yml` under `jobs:`:
```yaml
  e2e:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17-alpine
        env:
          POSTGRES_USER: agile
          POSTGRES_PASSWORD: agile_dev_password
          POSTGRES_DB: agile
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U agile -d agile" --health-interval 2s --health-retries 30
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Create app role
        run: |
          PGPASSWORD=agile_dev_password psql -h localhost -U agile -d agile -c \
            "CREATE ROLE app_user LOGIN PASSWORD 'app_user_dev_password'; GRANT USAGE ON SCHEMA public TO app_user;"
      - run: pnpm --filter @agile/e2e exec playwright install --with-deps chromium
      - run: pnpm e2e
        env:
          CI: "true"
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: e2e/playwright-report
```

- [ ] **Step 6: Final verification**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e && pnpm --filter @agile/web build`
Expected: all green; `next build` succeeds with no env vars set.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: self-host Docker packaging, README, and CI e2e"
```

---

## Spec coverage (Phase 1)

| Spec requirement | Task |
|---|---|
| Monorepo, CI (lint/typecheck/test) | 1, 13 |
| Docker Compose (dev + self-host) | 3, 13 |
| Postgres + Drizzle, `org_id` + RLS as second guard | 3 |
| better-auth orgs (workspaces, roles) | 4, 9 |
| Crypto package: AES-256-GCM, per-org DEK, KEK from env | 2, 7 |
| Jira connection: Cloud OAuth (default) / API token, DC PAT, test button | 5, 7, 10, 11 |
| Outbound URL policy / `ALLOWED_PRIVATE_HOSTS` (spec: SSRF guard) | 5, 8 |
| LLM BYOK: six providers, tool-calling probe, keys never to browser | 6, 8, 12 |
| Per-org default model | 8, 12 |
| Audit log for connection changes | 3, 7, 8, 11 |
| i18n EN/FR from day one | 9, 10, 12 |
| shadcn/ui, blocks before custom UI (user requirement) | 9, 10, 12 |
| Roles: owners/admins manage connections | 4, 7, 10, 12 |

Deferred by the spec to later phases (not in this plan): "cheap model" for digests (Phase 4), status-category mapping and board selection (Phase 2 — needs sync), mcp-atlassian wiring and tool allowlist (Phase 3), Manager/Viewer custom roles and SSO (Phase 5), KEK re-wrap command (Phase 5).
