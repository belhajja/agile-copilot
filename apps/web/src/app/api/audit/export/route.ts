import { readBodyCapped } from '@agile/net';
import { openAuditExport } from '@agile/privacy';
import { z } from 'zod';
import { currentActor, services } from '@/server/context';
import { isSameOrigin } from '@/server/same-origin';

export const dynamic = 'force-dynamic';

/** The form is three short fields. */
const MAX_FORM_BYTES = 2048;

const day = z.iso.date();
const query = z
  .object({
    format: z.enum(['csv', 'json']),
    from: day.optional(),
    to: day.optional(),
  })
  .strict();

/**
 * The workspace's audit log as a streamed download (owners and admins), from a form post of
 * `format`, `from` and `to` (UTC days; `to` is inclusive). Throttled: one running and a few per
 * hour per person (429). A POST from our own pages only (A-m5): a link or form on another site
 * cannot start exports and spend the person's quota.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: 'forbidden' }, { status: 403 });
  const actor = await currentActor(request.headers);
  if (!actor) return Response.json({ error: 'unauthorized' }, { status: 401 });
  let form: string;
  try {
    form = await readBodyCapped(request, MAX_FORM_BYTES);
  } catch {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }
  const params = Object.fromEntries(
    [...new URLSearchParams(form)].filter(([, v]) => v !== ''),
  ) as Record<string, string>;
  const parsed = query.safeParse(params);
  if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
  const { format, from, to } = parsed.data;
  const opened = await openAuditExport(services().db, actor, {
    format,
    from: from ? new Date(`${from}T00:00:00Z`) : undefined,
    to: to ? new Date(new Date(`${to}T00:00:00Z`).getTime() + 86_400_000) : undefined,
  });
  if (!opened.ok) {
    // A browser form navigation lands back on the audit page with the reason; callers get JSON.
    if (
      (opened.code === 'export_in_progress' || opened.code === 'export_rate_limited') &&
      request.headers.get('accept')?.includes('text/html')
    ) {
      return new Response(null, {
        status: 303,
        headers: { location: `/settings/audit?error=${opened.code}` },
      });
    }
    return Response.json(
      { error: opened.code },
      { status: opened.code === 'forbidden_role' ? 403 : opened.code === 'not_found' ? 404 : 429 },
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
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'audit_export_failed',
            name: (e as Error)?.name,
          }),
        );
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
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      'content-type':
        format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
      'content-disposition': `attachment; filename="audit-log-${stamp}.${format === 'csv' ? 'csv' : 'jsonl'}"`,
      'cache-control': 'no-store',
    },
  });
}
