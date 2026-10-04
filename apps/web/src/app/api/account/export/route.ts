import { exportUserData } from '@agile/privacy';
import { currentSession, services } from '@/server/context';

export const dynamic = 'force-dynamic';

/**
 * Downloads everything the service holds about the signed-in person (GDPR access/portability),
 * as one JSON file streamed from the database. Needs a session only, not a workspace (M3).
 */
export async function GET(request: Request) {
  const signedIn = await currentSession(request.headers);
  if (!signedIn) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const chunks = exportUserData(services().db, signedIn.user.id);
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (e) {
        console.error(
          JSON.stringify({ level: 'error', event: 'export_failed', name: (e as Error)?.name }),
        );
        controller.error(e);
      }
    },
    async cancel() {
      await chunks.return(undefined);
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
