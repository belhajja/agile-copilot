import { handleAgentRequest } from '@agile/agent';
import { agentDeps } from '@/server/agent';
import { currentActor, services } from '@/server/context';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 64 * 1024;

// BETTER_AUTH_URL never changes while the process runs: compute its origin once.
let cachedOrigin: string | undefined;
const allowedOrigin = () => {
  cachedOrigin ??= new URL(services().env.BETTER_AUTH_URL).origin;
  return cachedOrigin;
};

/**
 * Same-origin only (the session cookie is SameSite=Lax; this is a second, explicit check): the
 * Origin must be ours, or, when the browser sent none, Sec-Fetch-Site must say same-origin.
 * Anything else, including a request with neither header, is refused.
 */
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin) return origin === allowedOrigin();
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

/** One chat turn (streamed). The browser sends a message or approval decisions, nothing else. */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: 'forbidden' }, { status: 403 });
  const actor = await currentActor(request.headers);
  if (!actor) return Response.json({ error: 'unauthorized' }, { status: 401 });
  // A chat turn is one short message or a few decisions: refuse big bodies before parsing.
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES)
    return Response.json({ error: 'payload_too_large' }, { status: 413 });
  const text = await request.text().catch(() => '');
  if (text.length > MAX_BODY_BYTES)
    return Response.json({ error: 'payload_too_large' }, { status: 413 });
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // unparsable: the agent answers 400
  }
  return handleAgentRequest(agentDeps(), actor, body);
}
