import { createHash, randomUUID } from 'node:crypto';
import {
  type Actor,
  agentAttachments,
  agentConversations,
  type Db,
  isUuid,
  type Tx,
  withOrg,
} from '@agile/db';
import type { FileUIPart, UIMessage } from 'ai';
import { and, eq, inArray } from 'drizzle-orm';
import {
  attachmentIdOf,
  attachmentUrl,
  type ImageMediaType,
  type ImageRefusal,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  sniffImageType,
} from './images';

export interface DecodedImage {
  mediaType: ImageMediaType;
  bytes: Buffer;
}

type Decoded<T> = { ok: true; value: T } | { ok: false; code: ImageRefusal };

/** Base64 of the largest accepted image: anything longer is refused before decoding. */
const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * One image the browser sent as a base64 data URL. Its type comes from its first bytes: the type
 * in the URL (and any file name) is ignored.
 */
export function decodeImage(url: string): Decoded<DecodedImage> {
  const comma = url.indexOf(',');
  const header = comma < 0 ? '' : url.slice(0, comma);
  if (!/^data:[^,]{0,200};base64$/i.test(header)) return { ok: false, code: 'unsupported_image' };
  const payload = url.slice(comma + 1);
  if (payload.length > MAX_BASE64_LENGTH) return { ok: false, code: 'image_too_large' };
  if (payload.length % 4 !== 0 || !BASE64.test(payload)) {
    return { ok: false, code: 'unsupported_image' };
  }
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, code: 'image_too_large' };
  const mediaType = sniffImageType(bytes);
  if (!mediaType) return { ok: false, code: 'unsupported_image' };
  return { ok: true, value: { mediaType, bytes } };
}

/** The images of one chat message, all or nothing. */
export function decodeImages(urls: readonly string[]): Decoded<DecodedImage[]> {
  if (urls.length > MAX_IMAGES_PER_MESSAGE) return { ok: false, code: 'too_many_images' };
  const images: DecodedImage[] = [];
  for (const url of urls) {
    const decoded = decodeImage(url);
    if (!decoded.ok) return decoded;
    images.push(decoded.value);
  }
  return { ok: true, value: images };
}

/**
 * Stores a message's images in the caller's tenant transaction and returns the file parts that
 * name them. The caller must hold the actor's conversation (`beginTurn`): the foreign key alone
 * would accept another user's.
 */
export async function storeImages(
  tx: Tx,
  actor: Actor,
  conversationId: string,
  images: readonly DecodedImage[],
): Promise<FileUIPart[]> {
  if (images.length === 0) return [];
  const rows = images.map((image) => ({
    id: randomUUID(),
    orgId: actor.orgId,
    userId: actor.userId,
    conversationId,
    mediaType: image.mediaType,
    byteSize: image.bytes.length,
    sha256: createHash('sha256').update(image.bytes).digest('hex'),
    bytes: image.bytes,
  }));
  await tx.insert(agentAttachments).values(rows);
  return rows.map((r) => ({ type: 'file', mediaType: r.mediaType, url: attachmentUrl(r.id) }));
}

/** Said to the model in place of an image it cannot read. */
export const IMAGE_OMITTED = '[image omitted: this model does not read images]';
const IMAGE_LEFT_OUT = '[image omitted: an earlier image, not sent again]';
const IMAGE_MISSING = '[image omitted: no longer available]';

/**
 * Image bytes sent with one model request, newest images first: the current message's images
 * always fit; older ones are left out (with a note) once the budget is spent, so a long
 * conversation with images stays under the providers' request size limits.
 */
const MODEL_IMAGE_BUDGET_BYTES = MAX_IMAGES_PER_MESSAGE * MAX_IMAGE_BYTES;

const isFilePart = (p: UIMessage['parts'][number]): p is FileUIPart => p.type === 'file';

/**
 * The conversation as the model gets it: each stored image of the user's messages becomes the
 * image itself (a data URL) when the model reads images, otherwise a short note, so switching
 * models mid-conversation never breaks a request. Runs in the caller's tenant transaction.
 */
export async function imagesForModel(
  tx: Tx,
  conversationId: string,
  messages: UIMessage[],
  acceptsImages: boolean,
): Promise<UIMessage[]> {
  const ids = messages.flatMap((m) =>
    m.role === 'user'
      ? m.parts.filter(isFilePart).flatMap((p) => {
          const id = attachmentIdOf(p.url);
          return id ? [id] : [];
        })
      : [],
  );
  const dataUrls = new Map<string, string>();
  const leftOut = new Set<string>();
  if (acceptsImages && ids.length > 0) {
    const sizes = await tx
      .select({ id: agentAttachments.id, byteSize: agentAttachments.byteSize })
      .from(agentAttachments)
      .where(
        and(eq(agentAttachments.conversationId, conversationId), inArray(agentAttachments.id, ids)),
      );
    const sizeOf = new Map(sizes.map((r) => [r.id, r.byteSize]));
    const picked: string[] = [];
    let spent = 0;
    for (const id of [...ids].reverse()) {
      const size = sizeOf.get(id);
      if (size === undefined) continue;
      if (spent + size > MODEL_IMAGE_BUDGET_BYTES) {
        leftOut.add(id);
        continue;
      }
      spent += size;
      picked.push(id);
    }
    if (picked.length > 0) {
      const rows = await tx
        .select({
          id: agentAttachments.id,
          mediaType: agentAttachments.mediaType,
          bytes: agentAttachments.bytes,
        })
        .from(agentAttachments)
        .where(
          and(
            eq(agentAttachments.conversationId, conversationId),
            inArray(agentAttachments.id, picked),
          ),
        );
      for (const r of rows) {
        dataUrls.set(r.id, `data:${r.mediaType};base64,${Buffer.from(r.bytes).toString('base64')}`);
      }
    }
  }
  return messages.map((m) => {
    if (m.role !== 'user' || !m.parts.some(isFilePart)) return m;
    const parts = m.parts.map((p): UIMessage['parts'][number] => {
      if (!isFilePart(p)) return p;
      if (!acceptsImages) return { type: 'text', text: IMAGE_OMITTED };
      const id = attachmentIdOf(p.url);
      const url = id ? dataUrls.get(id) : undefined;
      if (url) return { ...p, url };
      return { type: 'text', text: id && leftOut.has(id) ? IMAGE_LEFT_OUT : IMAGE_MISSING };
    });
    return { ...m, parts };
  });
}

export interface StoredImage {
  mediaType: string;
  bytes: Buffer;
  sha256: string;
}

/**
 * A chat image, for the user whose conversation it belongs to (the rule for reading the
 * conversation); null for anyone else, or an unknown id.
 */
export async function loadAttachment(
  db: Db,
  actor: Actor,
  id: string,
): Promise<StoredImage | null> {
  if (!isUuid(id)) return null;
  const [row] = await withOrg(db, actor.orgId, (tx) =>
    tx
      .select({
        mediaType: agentAttachments.mediaType,
        bytes: agentAttachments.bytes,
        sha256: agentAttachments.sha256,
      })
      .from(agentAttachments)
      .innerJoin(agentConversations, eq(agentConversations.id, agentAttachments.conversationId))
      .where(
        and(
          eq(agentAttachments.id, id),
          eq(agentConversations.orgId, actor.orgId),
          eq(agentConversations.userId, actor.userId),
        ),
      ),
  );
  return row
    ? { mediaType: row.mediaType, bytes: Buffer.from(row.bytes), sha256: row.sha256 }
    : null;
}
