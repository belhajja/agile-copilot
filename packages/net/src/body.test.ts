import { describe, expect, it } from 'vitest';
import { BodyTooLargeError, readBodyCapped } from './body';

const request = (
  body: string | ReadableStream<Uint8Array> | null,
  headers: Record<string, string> = {},
) =>
  new Request('http://localhost/', {
    method: 'POST',
    body,
    headers,
    duplex: 'half',
  } as RequestInit);

const stream = (chunks: number[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const n of chunks) controller.enqueue(new Uint8Array(n).fill(0x61));
      controller.close();
    },
  });

describe('readBodyCapped', () => {
  it('returns the body as UTF-8 text, byte for byte', async () => {
    expect(await readBodyCapped(request('{ "a": "é€" }\n'), 64)).toBe('{ "a": "é€" }\n');
    expect(await readBodyCapped(request(null), 64)).toBe('');
  });

  it('counts bytes while streaming, whatever Content-Length says', async () => {
    expect(await readBodyCapped(request(stream([5, 5])), 10)).toBe('a'.repeat(10));
    await expect(readBodyCapped(request(stream([6, 5])), 10)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

  it('refuses a declared length over the cap before reading', async () => {
    await expect(
      readBodyCapped(request('{}', { 'content-length': '11' }), 10),
    ).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});
