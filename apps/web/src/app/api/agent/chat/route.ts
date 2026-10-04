import { handleAgentRequest } from '@agile/agent';
import { agentDeps } from '@/server/agent';
import { currentActor, services } from '@/server/context';

export const dynamic = 'force-dynamic';

/**
 * Same-origin only (the session cookie is SameSite=Lax; this is a second, explicit check): the
 * Origin must be ours, or, when the browser sent none, Sec-Fetch-Site must say same-origin.
 * Anything else, including a request with neither header, is refused.
 */
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin) return origin === new URL(services().env.BETTER_AUTH_URL).origin;
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

/** One chat turn (streamed). The browser sends a message or approval decisions, nothing else. */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: 'forbidden' }, { status: 403 });
  const actor = await currentActor(request.headers);
  if (!actor) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  return handleAgentRequest(agentDeps(), actor, body);
}
