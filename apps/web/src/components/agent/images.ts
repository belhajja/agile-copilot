import {
  IMAGE_MEDIA_TYPES,
  type ImageMediaType,
  type ImageRefusal,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  sniffImageType,
} from '@agile/agent/images';
import type { FileUIPart, UIMessage } from 'ai';

/** For the file picker; the bytes are checked anyway. */
export const IMAGE_ACCEPT = IMAGE_MEDIA_TYPES.join(',');

/**
 * Of `files`, those that can join the `pending` images, with the first refusal if any. The same
 * checks as the server: the type from the first bytes (never the name or the declared type), the
 * size and the count.
 */
export async function acceptImages(
  pending: number,
  files: readonly File[],
): Promise<{
  accepted: { file: File; mediaType: ImageMediaType }[];
  refusal: ImageRefusal | null;
}> {
  const accepted: { file: File; mediaType: ImageMediaType }[] = [];
  let refusal: ImageRefusal | null = null;
  for (const file of files) {
    if (file.size > MAX_IMAGE_BYTES) {
      refusal ??= 'image_too_large';
      continue;
    }
    const mediaType = sniffImageType(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
    if (!mediaType) {
      refusal ??= 'unsupported_image';
      continue;
    }
    if (pending + accepted.length >= MAX_IMAGES_PER_MESSAGE) {
      refusal ??= 'too_many_images';
      continue;
    }
    accepted.push({ file, mediaType });
  }
  return { accepted, refusal };
}

/** The image parts of a message, in order. */
export const imagePartsOf = (message: UIMessage): FileUIPart[] =>
  message.parts.filter(
    (p): p is FileUIPart => p.type === 'file' && p.mediaType.startsWith('image/'),
  );

/** An image as a data URL with its detected type, the way the chat request carries it. */
export function readAsDataUrl(file: File, mediaType: ImageMediaType): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(`data:${mediaType};base64,${url.slice(url.indexOf(',') + 1)}`);
    };
    reader.onerror = () => reject(reader.error ?? new Error('unreadable file'));
    reader.readAsDataURL(file);
  });
}
