// Shared with the browser (`@agile/agent/images`): keep this file free of server imports.

/** The image types a chat message may carry, told apart by their first bytes. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** Images per chat message. */
export const MAX_IMAGES_PER_MESSAGE = 4;
/** Largest image accepted, in bytes (decoded). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Why an image is refused; the chat request answers with the same codes. */
export type ImageRefusal = 'unsupported_image' | 'image_too_large' | 'too_many_images';

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0) =>
  bytes.length >= at + signature.length && signature.every((b, i) => bytes[at + i] === b);

/**
 * The image type of `bytes` from its signature (the declared type and the file name are never
 * trusted), or null. The first 12 bytes are enough.
 */
export function sniffImageType(bytes: Uint8Array): ImageMediaType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  // RIFF....WEBP
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    return 'image/webp';
  return null;
}

const ATTACHMENT_PATH = '/api/agent/attachments/';
const ATTACHMENT_URL = /^\/api\/agent\/attachments\/([0-9a-f-]{36})$/;

/** Where the browser loads a stored chat image (the url of its file part). */
export const attachmentUrl = (id: string) => `${ATTACHMENT_PATH}${id}`;

/** The attachment id of a stored image's url, or null for any other url. */
export const attachmentIdOf = (url: string): string | null => ATTACHMENT_URL.exec(url)?.[1] ?? null;
