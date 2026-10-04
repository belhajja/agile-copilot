/** The request body is larger than the allowed maximum. */
export class BodyTooLargeError extends Error {
  override name = 'BodyTooLargeError';
  constructor() {
    super('body_too_large');
  }
}

/**
 * Reads a request body as text, counting bytes while streaming and stopping at `max` (P3-R9): a
 * missing or false Content-Length changes nothing. A declared length above the cap is refused
 * before reading, as a shortcut only.
 */
export async function readBodyCapped(request: Request, max: number): Promise<string> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await request.body?.cancel().catch(() => {});
    throw new BodyTooLargeError();
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
