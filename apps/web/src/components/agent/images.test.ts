import { MAX_IMAGE_BYTES } from '@agile/agent/images';
import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { acceptImages, IMAGE_ACCEPT, imagePartsOf } from './images';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ok = (files: File[], types: string[]) =>
  files.map((f, i) => ({ file: f, mediaType: types[i] ?? types[0] }));
const file = (head: number[] | string, size = 64, name = 'a.png', type = 'image/png') => {
  const start = typeof head === 'string' ? Buffer.from(head, 'latin1') : Buffer.from(head);
  return new File([start, new Uint8Array(Math.max(0, size - start.length))], name, { type });
};

describe('acceptImages', () => {
  it('takes PNG, JPEG and WebP by their first bytes, whatever their name or declared type', async () => {
    const files = [
      file(PNG, 64, 'photo.gif', 'image/gif'),
      file([0xff, 0xd8, 0xff, 0xe0], 64, 'scan', ''),
      file('RIFF\x10\x00\x00\x00WEBPVP8 ', 64, 'x.webp', 'image/webp'),
    ];
    expect(await acceptImages(0, files)).toEqual({
      accepted: ok(files, ['image/png', 'image/jpeg', 'image/webp']),
      refusal: null,
    });
  });

  it('refuses other types, even named and declared as images', async () => {
    const gif = file('GIF89a', 64, 'a.png', 'image/png');
    const svg = file('<svg xmlns="http://www.w3.org/2000/svg"/>', 64, 'a.svg', 'image/svg+xml');
    const png = file(PNG);
    expect(await acceptImages(0, [gif, png, svg])).toEqual({
      accepted: ok([png], ['image/png']),
      refusal: 'unsupported_image',
    });
    expect(await acceptImages(0, [file([], 0)])).toEqual({
      accepted: [],
      refusal: 'unsupported_image',
    });
  });

  it('refuses images over 5 MB, the limit itself is fine', async () => {
    const atLimit = file(PNG, MAX_IMAGE_BYTES);
    expect(await acceptImages(0, [atLimit, file(PNG, MAX_IMAGE_BYTES + 1)])).toEqual({
      accepted: ok([atLimit], ['image/png']),
      refusal: 'image_too_large',
    });
  });

  it('keeps a message to four images, counting those already added', async () => {
    const five = Array.from({ length: 5 }, () => file(PNG));
    expect(await acceptImages(0, five)).toEqual({
      accepted: ok(five.slice(0, 4), ['image/png']),
      refusal: 'too_many_images',
    });
    expect(await acceptImages(3, five.slice(0, 2))).toEqual({
      accepted: ok(five.slice(0, 1), ['image/png']),
      refusal: 'too_many_images',
    });
    expect(await acceptImages(4, [file(PNG)])).toEqual({
      accepted: [],
      refusal: 'too_many_images',
    });
  });

  it('offers the same three types to the file picker', () => {
    expect(IMAGE_ACCEPT).toBe('image/png,image/jpeg,image/webp');
  });
});

describe('imagePartsOf', () => {
  it('returns the image parts of a message in order', () => {
    const message: UIMessage = {
      id: 'u1',
      role: 'user',
      parts: [
        { type: 'file', mediaType: 'image/png', url: '/api/agent/attachments/a' },
        { type: 'text', text: 'What is this?' },
        { type: 'file', mediaType: 'image/jpeg', url: '/api/agent/attachments/b' },
      ],
    };
    expect(imagePartsOf(message).map((p) => p.url)).toEqual([
      '/api/agent/attachments/a',
      '/api/agent/attachments/b',
    ]);
  });
});
