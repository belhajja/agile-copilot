import { isAllowlistedHost, normalizeHost } from '@agile/net';
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

const emailList = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  )
  .transform((l) => [...new Set(l)])
  .pipe(z.array(z.email()));

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
    /** Shared mcp-atlassian instance (streamable HTTP endpoint) for the agent's live Jira tools. */
    MCP_ATLASSIAN_URL: z.preprocess(emptyToUndefined, z.url().optional()),
    /**
     * The read-only mcp-atlassian twin for skill runs (background runs and builder previews):
     * live Jira reads for Data Center PATs and Cloud OAuth. Unset = those runs use synced data only.
     */
    MCP_ATLASSIAN_READONLY_URL: z.preprocess(emptyToUndefined, z.url().optional()),
    /** Skill runs (schedules, alerts, "Run now") per workspace and rolling 24 hours; 0 disables runs. */
    SKILL_RUNS_DAILY_LIMIT: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(0).max(10_000).default(50),
    ),
    /** Single sign-on: the deployment's OIDC identity provider (Keycloak or any OIDC IdP). */
    OIDC_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['keycloak', 'oidc']).default('keycloak')),
    OIDC_ISSUER: z.preprocess(emptyToUndefined, z.url().optional()),
    OIDC_CLIENT_ID: optionalString,
    OIDC_CLIENT_SECRET: optionalString,
    /** Label of the sign-in button, e.g. "Acme SSO". */
    OIDC_DISPLAY_NAME: z.preprocess(emptyToUndefined, z.string().min(1).max(40).default('SSO')),
    /** `admin_only`: passwords only for BREAK_GLASS_EMAILS; everyone else signs in with SSO. */
    PASSWORD_LOGIN: z.preprocess(emptyToUndefined, z.enum(['all', 'admin_only']).default('all')),
    /** Platform admin (break-glass) accounts, comma-separated. */
    BREAK_GLASS_EMAILS: emailList,
    /** Stripe billing (DEPLOYMENT_MODE=saas only; ignored by self-host builds). */
    STRIPE_SECRET_KEY: optionalString,
    STRIPE_WEBHOOK_SECRET: optionalString,
    STRIPE_PRICE_TEAM: optionalString,
    /** Development and tests: a stripe-mock URL instead of api.stripe.com. */
    STRIPE_API_URL: z.preprocess(emptyToUndefined, z.url().optional()),
    /** Optional LLM tracing (Langfuse): off unless both keys are set. */
    LANGFUSE_PUBLIC_KEY: optionalString,
    LANGFUSE_SECRET_KEY: optionalString,
    LANGFUSE_BASE_URL: z.preprocess(
      emptyToUndefined,
      z.url().default('https://cloud.langfuse.com'),
    ),
    /** External MCP clients: requests per personal token per minute. */
    MCP_RATE_LIMIT_PER_MINUTE: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1).max(10_000).default(60),
    ),
    /**
     * Reverse proxies in front of the app that append the client address to X-Forwarded-For
     * (1 = an ingress or load balancer; 2 = a CDN, then the ingress). 0 (default): the header is
     * never trusted, so a client cannot choose its own address. Used by the pre-auth limit of
     * `/api/mcp`.
     */
    TRUSTED_PROXY_HOPS: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(0).max(5).default(0),
    ),
  })
  .refine(
    (e) => Boolean(e.ATLASSIAN_OAUTH_CLIENT_ID) === Boolean(e.ATLASSIAN_OAUTH_CLIENT_SECRET),
    {
      message: 'ATLASSIAN_OAUTH_CLIENT_ID and ATLASSIAN_OAUTH_CLIENT_SECRET must be set together',
      path: ['ATLASSIAN_OAUTH_CLIENT_ID'],
    },
  )
  .refine(
    (e) =>
      new Set([Boolean(e.OIDC_ISSUER), Boolean(e.OIDC_CLIENT_ID), Boolean(e.OIDC_CLIENT_SECRET)])
        .size === 1,
    {
      message: 'OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET must be set together',
      path: ['OIDC_ISSUER'],
    },
  )
  .refine(
    (e) =>
      new Set([
        Boolean(e.STRIPE_SECRET_KEY),
        Boolean(e.STRIPE_WEBHOOK_SECRET),
        Boolean(e.STRIPE_PRICE_TEAM),
      ]).size === 1,
    {
      message:
        'STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRICE_TEAM must be set together',
      path: ['STRIPE_SECRET_KEY'],
    },
  )
  .refine((e) => Boolean(e.LANGFUSE_PUBLIC_KEY) === Boolean(e.LANGFUSE_SECRET_KEY), {
    message: 'LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set together',
    path: ['LANGFUSE_PUBLIC_KEY'],
  })
  .refine(
    (e) =>
      e.PASSWORD_LOGIN !== 'admin_only' ||
      (Boolean(e.OIDC_ISSUER) && e.BREAK_GLASS_EMAILS.length > 0),
    {
      message:
        'PASSWORD_LOGIN=admin_only needs SSO (OIDC_ISSUER…) and at least one BREAK_GLASS_EMAILS address',
      path: ['PASSWORD_LOGIN'],
    },
  )
  .superRefine((e, ctx) => {
    // Secrets travel to these URLs: plaintext only for loopback or an allowlisted host.
    for (const key of ['OIDC_ISSUER', 'STRIPE_API_URL', 'LANGFUSE_BASE_URL'] as const) {
      const raw = e[key];
      if (!raw) continue;
      const url = new URL(raw);
      const host = normalizeHost(url.hostname);
      const local = ['127.0.0.1', '::1', 'localhost'].includes(host);
      if (url.protocol === 'https:') continue;
      if (url.protocol === 'http:' && (local || isAllowlistedHost(host, e.ALLOWED_PRIVATE_HOSTS)))
        continue;
      ctx.addIssue({
        code: 'custom',
        message: `${key} must use https (http only for localhost or ALLOWED_PRIVATE_HOSTS)`,
        path: [key],
      });
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/** Langfuse settings when tracing is on (both keys set); null = off (the default). */
export function langfuseConfigOf(env: ServerEnv) {
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return null;
  return {
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    baseUrl: env.LANGFUSE_BASE_URL,
    environment: env.DEPLOYMENT_MODE,
  };
}

/** Stripe settings when billing is on: SaaS deployments with Stripe configured. Never self-host. */
export function billingConfigOf(env: ServerEnv) {
  if (env.DEPLOYMENT_MODE !== 'saas' || !env.STRIPE_SECRET_KEY) return null;
  if (!env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_PRICE_TEAM) return null;
  return {
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    priceTeam: env.STRIPE_PRICE_TEAM,
    apiUrl: env.STRIPE_API_URL,
  };
}

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
