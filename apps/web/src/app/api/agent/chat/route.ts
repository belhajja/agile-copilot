import { handleAgentRequest } from '@agile/agent';
import { BodyTooLargeError, readBodyCapped } from '@agile/net';
import { agentDeps } from '@/server/agent';
import { currentActor } from '@/server/context';
import { isSameOrigin } from '@/server/same-origin';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 64 * 1024;

/** One chat turn (streamed). The browser sends a message or approval decisions, nothing else. */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: 'forbidden' }, { status: 403 });
  const actor = await currentActor(request.headers);
  if (!actor) return Response.json({ error: 'unauthorized' }, { status: 401 });
  // A chat turn is one short message or a few decisions: refuse big bodies before parsing,
  // counting bytes as they stream in (a missing or false Content-Length changes nothing).
  let text = '';
  try {
    text = await readBodyCapped(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return Response.json({ error: 'payload_too_large' }, { status: 413 });
    }
    // An unreadable body (client gone): the agent answers 400 to the empty text.
  }
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // unparsable: the agent answers 400
  }
  return handleAgentRequest(agentDeps(), actor, body);
}
