import { describe, expect, it } from 'vitest';
import { decodeImage, decodeImages } from './attachments';
import { attachmentIdOf, attachmentUrl, MAX_IMAGE_BYTES, sniffImageType } from './images';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const WEBP = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1');
const GIF = Buffer.from('GIF89a', 'latin1');

const image = (signature: Buffer, size = 64) =>
  Buffer.concat([signature, Buffer.alloc(Math.max(0, size - signature.length), 7)]);
const dataUrl = (bytes: Buffer, declared = 'image/png') =>
  `data:${declared};base64,${bytes.toString('base64')}`;

describe('sniffImageType', () => {
  it('tells PNG, JPEG and WebP apart by their first bytes', () => {
    expect(sniffImageType(image(PNG))).toBe('image/png');
    expect(sniffImageType(image(JPEG))).toBe('image/jpeg');
    expect(sniffImageType(image(WEBP))).toBe('image/webp');
  });

  it('refuses anything else, and truncated signatures', () => {
    expect(sniffImageType(image(GIF))).toBeNull();
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(Buffer.from('RIFF\x10\x00\x00\x00WAVE', 'latin1'))).toBeNull();
    expect(sniffImageType(PNG.subarray(0, 4))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe('decodeImage', () => {
  it('trusts the bytes, never the declared type', () => {
    const png = image(PNG);
    expect(decodeImage(dataUrl(png, 'image/gif'))).toEqual({
      ok: true,
      value: { mediaType: 'image/png', bytes: png },
    });
    expect(decodeImage(dataUrl(image(GIF), 'image/png'))).toEqual({
      ok: false,
      code: 'unsupported_image',
    });
  });

  it('accepts exactly the size limit and refuses one byte more', () => {
    expect(decodeImage(dataUrl(image(JPEG, MAX_IMAGE_BYTES)))).toMatchObject({
      ok: true,
      value: { mediaType: 'image/jpeg' },
    });
    expect(decodeImage(dataUrl(image(JPEG, MAX_IMAGE_BYTES + 1)))).toEqual({
      ok: false,
      code: 'image_too_large',
    });
  });

  it('refuses what is not a base64 data URL', () => {
    const b64 = image(PNG).toString('base64');
    for (const url of [
      `https://example.com/a.png`,
      `/api/agent/attachments/${'0'.repeat(36)}`,
      `data:image/png,${b64}`,
      `data:image/png;base64,${b64.slice(1)}`,
      `data:image/png;base64,${b64.slice(0, -4)}*!==`,
      'data:image/png;base64,',
    ]) {
      expect(decodeImage(url)).toEqual({ ok: false, code: 'unsupported_image' });
    }
  });
});

describe('decodeImages', () => {
  it('takes up to four images, all or nothing', () => {
    const url = dataUrl(image(PNG));
    expect(decodeImages([url, url, url, url])).toMatchObject({ ok: true });
    expect(decodeImages([url, url, url, url, url])).toEqual({ ok: false, code: 'too_many_images' });
    expect(decodeImages([url, dataUrl(image(GIF))])).toEqual({
      ok: false,
      code: 'unsupported_image',
    });
  });
});

describe('attachment urls', () => {
  it('round-trip an id and match nothing else', () => {
    const id = '0f4c1b9e-5d3a-4a52-8d52-2f1c7a9a0b11';
    expect(attachmentIdOf(attachmentUrl(id))).toBe(id);
    expect(attachmentIdOf(`${attachmentUrl(id)}?x=1`)).toBeNull();
    expect(attachmentIdOf(`https://evil.example${attachmentUrl(id)}`)).toBeNull();
    expect(attachmentIdOf('data:image/png;base64,AAAA')).toBeNull();
  });
});
