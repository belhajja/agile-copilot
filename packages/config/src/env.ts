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
