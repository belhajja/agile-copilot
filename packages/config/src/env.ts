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
  })
  .refine(
    (e) => Boolean(e.ATLASSIAN_OAUTH_CLIENT_ID) === Boolean(e.ATLASSIAN_OAUTH_CLIENT_SECRET),
    {
      message: 'ATLASSIAN_OAUTH_CLIENT_ID and ATLASSIAN_OAUTH_CLIENT_SECRET must be set together',
      path: ['ATLASSIAN_OAUTH_CLIENT_ID'],
    },
  );

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
