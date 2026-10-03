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
