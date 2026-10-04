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

type Session = Awaited<ReturnType<typeof loadSession>>;

async function actorOf(session: Session): Promise<SessionActor | null> {
  const orgId = session?.session.activeOrganizationId;
  if (!session || !orgId) return null;
  const roles = await getMemberRoles(services().db, orgId, session.user.id);
  if (roles.length === 0) return null;
  const { id, name, email } = session.user;
  return { orgId, userId: id, roles, user: { id, name, email } };
}

/**
 * For Route Handlers: the signed-in member of the active workspace, or null (the route answers
 * 401). Reads the session from the request's own headers, without React `cache` (request-scoped
 * only while rendering Server Components) or `headers()`.
 */
export async function currentActor(requestHeaders: Headers): Promise<SessionActor | null> {
  return actorOf(await services().auth.api.getSession({ headers: requestHeaders }));
}

export async function requireActor(): Promise<SessionActor> {
  const actor = await actorOf(await requireSignedIn());
  if (!actor) redirect('/onboarding');
  return actor;
}
