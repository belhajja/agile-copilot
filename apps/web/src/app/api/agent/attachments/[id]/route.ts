import { loadAttachment } from '@agile/agent';
import { currentActor, services } from '@/server/context';

export const dynamic = 'force-dynamic';

/**
 * An image attached to a chat message, for the person whose conversation it is (anyone else gets
 * 404, as for the conversation). Served as stored: its type was detected from its bytes when it
 * was sent, and nosniff keeps browsers to it.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await currentActor(request.headers);
  if (!actor) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  const image = await loadAttachment(services().db, actor, id);
  if (!image) return Response.json({ error: 'not_found' }, { status: 404 });
  const etag = `"${image.sha256}"`;
  const headers = {
    'Content-Type': image.mediaType,
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    // The bytes of an id never change; only this person may see them.
    'Cache-Control': 'private, max-age=86400, immutable',
    ETag: etag,
  };
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(new Uint8Array(image.bytes), {
    headers: { ...headers, 'Content-Length': String(image.bytes.length) },
  });
}
