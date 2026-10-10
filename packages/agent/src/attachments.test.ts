import { createHash, randomUUID } from 'node:crypto';
import { setLlmAcceptsImages } from '@agile/connections';
import { agentAttachments, agentMessages, llmConnections, withOrg } from '@agile/db';
import type { MockChatMessage } from '@agile/llm/testing';
import { member, owner } from '@agile/sync/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IMAGE_OMITTED, loadAttachment } from './attachments';
import { deleteConversation } from './conversations';
import { attachmentIdOf } from './images';
import { startAgentHarness, textOf } from './test-harness';

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(1_000, 3),
]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 4)]);
const gif = Buffer.from('GIF89a-not-accepted', 'latin1');
const url = (bytes: Buffer, declared = 'image/png') =>
  `data:${declared};base64,${bytes.toString('base64')}`;

describe('chat images', () => {
  let h: Awaited<ReturnType<typeof startAgentHarness>>;
  let modelId = '';
  const setAccepts = (accepts: boolean, actor = owner()) =>
    setLlmAcceptsImages(h.deps, actor, modelId, accepts);
  const sendImages = (
    conversationId: string,
    images: string[],
    text = 'What is on these?',
    actor = owner(),
  ) =>
    h.send(actor, {
      conversationId,
      message: { id: randomUUID(), text, images: images.map((u) => ({ url: u })) },
    });
  /** The last user message of the last model request. */
  const lastUserSent = (): MockChatMessage | undefined =>
    [...(h.llm.requests.at(-1)?.messages ?? [])].reverse().find((m) => m.role === 'user');
  const storedUserParts = async (conversationId: string) => {
    const rows = await h.rawDb
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.conversationId, conversationId));
    return rows.filter((r) => r.role === 'user').map((r) => r.parts);
  };

  beforeAll(async () => {
    h = await startAgentHarness();
    const [row] = await h.rawDb
      .select({ id: llmConnections.id })
      .from(llmConnections)
      .where(eq(llmConnections.orgId, 'org_a'));
    if (!row) throw new Error('no model');
    modelId = row.id;
  });
  afterAll(async () => h?.stop());

  it('refuses images while the model does not read them, and stores nothing', async () => {
    await setAccepts(false);
    const id = randomUUID();
    expect(await sendImages(id, [url(png)])).toMatchObject({
      status: 409,
      error: 'images_not_supported',
    });
    expect(await h.rawDb.select().from(agentAttachments)).toEqual([]);
  });

  it('refuses unsupported, oversized and too many images with their own codes', async () => {
    await setAccepts(true);
    const id = randomUUID();
    expect(await sendImages(id, [url(gif)])).toMatchObject({
      status: 415,
      error: 'unsupported_image',
    });
    // A GIF declared as PNG is still a GIF.
    expect(await sendImages(id, [url(png), url(gif, 'image/png')])).toMatchObject({
      error: 'unsupported_image',
    });
    const big = Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]);
    expect(await sendImages(id, [url(big)])).toMatchObject({
      status: 413,
      error: 'image_too_large',
    });
    expect(await sendImages(id, Array(5).fill(url(png)))).toMatchObject({
      status: 400,
      error: 'too_many_images',
    });
    // Text or images: an empty message is no message.
    expect(await sendImages(id, [], '  ')).toMatchObject({ status: 400, error: 'invalid_request' });
    expect(await h.rawDb.select().from(agentAttachments)).toEqual([]);
  });

  it('stores the images apart, names them in the message and sends their bytes to the model', async () => {
    await setAccepts(true);
    const id = randomUUID();
    const r = await sendImages(id, [url(png, 'image/webp'), url(jpeg)]);
    expect(r.status).toBe(200);
    expect(textOf(r.chunks)).toBe(
      `I received 2 images (image/png, ${png.length} bytes; image/jpeg, ${jpeg.length} bytes).`,
    );
    const [parts] = await storedUserParts(id);
    expect(parts).toEqual([
      { type: 'text', text: 'What is on these?' },
      {
        type: 'file',
        mediaType: 'image/png',
        url: expect.stringMatching(/^\/api\/agent\/attachments\//),
      },
      {
        type: 'file',
        mediaType: 'image/jpeg',
        url: expect.stringMatching(/^\/api\/agent\/attachments\//),
      },
    ]);
    expect(JSON.stringify(parts)).not.toContain('base64');
    const rows = await h.rawDb
      .select()
      .from(agentAttachments)
      .where(eq(agentAttachments.conversationId, id));
    expect(rows).toHaveLength(2);
    const byType = Object.fromEntries(rows.map((a) => [a.mediaType, a]));
    expect(byType['image/png']).toMatchObject({
      orgId: 'org_a',
      userId: owner().userId,
      byteSize: png.length,
      sha256: createHash('sha256').update(png).digest('hex'),
    });
    expect(Buffer.from(byType['image/png']?.bytes ?? []).equals(png)).toBe(true);
  });

  it('accepts images without text', async () => {
    await setAccepts(true);
    const id = randomUUID();
    const r = await sendImages(id, [url(png)], '');
    expect(textOf(r.chunks)).toBe(`I received 1 image (image/png, ${png.length} bytes).`);
    const [parts] = await storedUserParts(id);
    expect(parts?.map((p) => (p as { type: string }).type)).toEqual(['file']);
  });

  it('sends earlier images again with the history, or a note once the model no longer reads them', async () => {
    await setAccepts(true);
    const id = randomUUID();
    await sendImages(id, [url(png)]);
    await h.ask(owner(), id, 'And now?');
    const firstUser = h.llm.requests
      .at(-1)
      ?.messages.find((m) => m.role === 'user' && Array.isArray(m.content));
    expect(firstUser?.content).toContainEqual({
      type: 'image_url',
      image_url: { url: url(png) },
    });

    await setAccepts(false);
    const r = await h.ask(owner(), id, 'What about now?');
    expect(r.status).toBe(200);
    const sent = JSON.stringify(h.llm.requests.at(-1)?.messages);
    expect(sent).not.toContain('image_url');
    expect(sent).toContain(IMAGE_OMITTED);
    expect(lastUserSent()?.content).toBe('What about now?');
  });

  it('leaves the oldest images out once a request would carry more than four large ones', async () => {
    await setAccepts(true);
    const id = randomUUID();
    const large = (n: number) =>
      url(Buffer.concat([png.subarray(0, 8), Buffer.alloc(5 * 1024 * 1024 - 8, n)]));
    expect((await sendImages(id, [large(1), large(2), large(3), large(4)])).status).toBe(200);
    expect((await sendImages(id, [url(png)], 'One more')).status).toBe(200);
    await h.ask(owner(), id, 'Compare them');
    const sent = h.llm.requests.at(-1)?.messages ?? [];
    const images = sent.flatMap((m) =>
      Array.isArray(m.content) ? m.content.filter((c) => c.type === 'image_url') : [],
    );
    expect(images).toHaveLength(4);
    expect(images.at(-1)).toEqual({ type: 'image_url', image_url: { url: url(png) } });
    expect(JSON.stringify(sent)).toContain('[image omitted: an earlier image, not sent again]');
    expect(JSON.stringify(sent)).not.toContain(large(1).slice(-64));
  });

  it('serves an image to the owner of its conversation only', async () => {
    await setAccepts(true);
    const id = randomUUID();
    await sendImages(id, [url(jpeg)]);
    const [parts] = await storedUserParts(id);
    const attachmentId =
      attachmentIdOf((parts?.[1] as { url: string } | undefined)?.url ?? '') ?? '';
    const mine = await loadAttachment(h.db, owner(), attachmentId);
    expect(mine?.mediaType).toBe('image/jpeg');
    expect(mine?.bytes.equals(jpeg)).toBe(true);
    // Another member of the workspace, another workspace, a bad id.
    expect(await loadAttachment(h.db, member(), attachmentId)).toBeNull();
    expect(
      await loadAttachment(h.db, { ...owner('org_b'), userId: owner().userId }, attachmentId),
    ).toBeNull();
    expect(await loadAttachment(h.db, owner(), 'not-a-uuid')).toBeNull();
    // The app role sees another workspace's rows nowhere (RLS), whatever it asks.
    const seen = await withOrg(h.db, 'org_b', (tx) =>
      tx.select({ id: agentAttachments.id }).from(agentAttachments),
    );
    expect(seen).toEqual([]);
    await expect(
      withOrg(h.db, 'org_b', (tx) =>
        tx.insert(agentAttachments).values({
          orgId: 'org_a',
          userId: owner().userId,
          conversationId: id,
          mediaType: 'image/png',
          byteSize: png.length,
          sha256: 'x',
          bytes: png,
        }),
      ),
    ).rejects.toThrow();
  });

  it('goes away with its conversation', async () => {
    await setAccepts(true);
    const id = randomUUID();
    await sendImages(id, [url(png)]);
    const count = async () =>
      (
        await h.rawDb
          .select({ id: agentAttachments.id })
          .from(agentAttachments)
          .where(eq(agentAttachments.conversationId, id))
      ).length;
    expect(await count()).toBe(1);
    expect(await deleteConversation(h.db, owner(), id)).toBe('deleted');
    expect(await count()).toBe(0);
  });
});
