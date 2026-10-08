import { errorName, log } from '@agile/observability/log';
import { openUserExport } from '@agile/privacy';
import { currentSession, services } from '@/server/context';
import { isSameOrigin } from '@/server/same-origin';

export const dynamic = 'force-dynamic';

/**
 * Downloads everything the service holds about the signed-in person (GDPR access/portability),
 * as one JSON file streamed from the database. Needs a session only, not a workspace (M3).
 * Throttled (one running per person, a few per hour): 429 with a fixed code, or, for the
 * Account page's form, back to that page with the reason. A POST from our own pages only
 * (A-m5): a link or form on another site cannot start exports and spend the person's quota.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: 'forbidden' }, { status: 403 });
  const signedIn = await currentSession(request.headers);
  if (!signedIn) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const opened = await openUserExport(services().db, signedIn.user.id);
  if (!opened.ok) {
    if (opened.code !== 'not_found' && request.headers.get('accept')?.includes('text/html')) {
      return new Response(null, {
        status: 303,
        headers: { location: `/settings/account?export_error=${opened.code}` },
      });
    }
    return Response.json(
      { error: opened.code },
      { status: opened.code === 'not_found' ? 404 : 429 },
    );
  }
  const { chunks, finish } = opened;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) {
          await finish();
          controller.close();
        } else controller.enqueue(encoder.encode(next.value));
      } catch (e) {
        log('error', 'export_failed', { error: errorName(e) });
        await finish();
        controller.error(e);
      }
    },
    async cancel() {
      await chunks.return(undefined);
      // Also when the download is dropped before the first piece (the generator never started).
      await finish();
    },
  });
  const day = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="agile-copilot-my-data-${day}.json"`,
      'cache-control': 'no-store',
    },
  });
}
