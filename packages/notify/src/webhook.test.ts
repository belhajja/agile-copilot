import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DeliveryError } from './errors';
import { type MockWebhook, startMockWebhook } from './testing';
import { postWebhook, sendWebhook, slackPayload, teamsPayload } from './webhook';

const message = {
  title: 'Report: sprint-digest',
  text: 'Ping <!channel> and see <https://evil.example|the report> & more',
  link: 'https://copilot.example.com/skills/1',
};

describe('Slack and Teams payloads', () => {
  it('escapes Slack control characters and turns unfurling off', () => {
    const p = slackPayload(message);
    expect(p.unfurl_links).toBe(false);
    expect(p.unfurl_media).toBe(false);
    const section = p.blocks[1] as { text: { text: string } };
    expect(section.text.text).toBe(
      'Ping &lt;!channel&gt; and see &lt;https://evil.example|the report&gt; &amp; more',
    );
    expect(JSON.stringify(p)).not.toContain('<!channel>');
  });

  it('keeps @channel, @here and #channel names literal (verbatim, no link_names)', () => {
    const p = slackPayload({ title: 't', text: 'Hi @channel @here see #general', link: 'l' });
    expect(p).not.toHaveProperty('link_names');
    const section = p.blocks[1] as { text: { type: string; text: string; verbatim?: boolean } };
    expect(section.text).toEqual({
      type: 'mrkdwn',
      text: 'Hi @channel @here see #general',
      verbatim: true,
    });
    const context = p.blocks[2] as { elements: { verbatim?: boolean }[] };
    expect(context.elements[0]?.verbatim).toBe(true);
  });

  it('never cuts an escaped entity in half, and caps the fallback text', () => {
    const p = slackPayload({ title: '<'.repeat(400), text: '&'.repeat(5_000) });
    const section = (p.blocks[1] as { text: { text: string } }).text.text;
    expect(section.length).toBeLessThanOrEqual(2_900);
    expect(section).toMatch(/^(?:&amp;)+…$/);
    expect(p.text.length).toBeLessThanOrEqual(150);
    expect(p.text).toMatch(/^(?:&lt;)+…$/);
  });

  it('neutralises Markdown links and images in Teams text and titles', () => {
    const t = teamsPayload({
      title: 'See [the board](https://evil.example/t)',
      text: 'Open [the report](https://evil.example/r) ![x](https://evil.example/p.png) [a][r]\n\n[r]: https://evil.example/ref',
      link: message.link,
    });
    const [title, text, link] = (t.attachments[0]?.content.body ?? []).map((b) => b.text);
    expect(title).toBe('See ［the board］(https://evil.example/t)');
    expect(text).toBe(
      'Open ［the report］(https://evil.example/r) !［x］(https://evil.example/p.png) ［a］［r］\n\n［r］: https://evil.example/ref',
    );
    expect(`${title}${text}`).not.toMatch(/[[\]]/);
    // Our own link back to the app is left as it is.
    expect(link).toBe(message.link);
  });

  it('truncates long reports to what each platform accepts', () => {
    const long = { title: 't'.repeat(300), text: 'x'.repeat(50_000) };
    const slack = slackPayload(long);
    expect((slack.blocks[0] as { text: { text: string } }).text.text.length).toBe(150);
    expect((slack.blocks[1] as { text: { text: string } }).text.text.length).toBe(2_900);
    const teams = teamsPayload(long);
    const body = teams.attachments[0]?.content.body ?? [];
    expect(body[1]?.text.length).toBe(20_000);
  });

  it('posts Teams messages as an Adaptive Card', () => {
    const t = teamsPayload(message);
    expect(t.attachments[0]?.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(t.attachments[0]?.content.body.map((b) => b.text)).toEqual([
      message.title,
      message.text,
      message.link,
    ]);
  });
});

describe('postWebhook', () => {
  let hook: MockWebhook;
  beforeAll(async () => {
    hook = await startMockWebhook();
  });
  afterAll(async () => hook?.close());

  const outbound = { allowedPrivateHosts: ['127.0.0.1'] };
  const failure = (p: Promise<unknown>) =>
    p.then(
      () => 'no error',
      (e: unknown) =>
        e instanceof DeliveryError ? [e.code, e.status ?? null] : `other: ${(e as Error).name}`,
    );

  it('posts the JSON payload', async () => {
    await postWebhook('slack', `${hook.url}/services/T/B/x`, message, { outbound });
    expect(hook.posts.at(-1)).toMatchObject({
      path: '/services/T/B/x',
      body: { text: 'Report: sprint-digest', unfurl_links: false },
    });
  });

  it('reports refusals, redirects and timeouts with codes', async () => {
    expect(await failure(postWebhook('teams', `${hook.url}/fail`, message, { outbound }))).toEqual([
      'rejected',
      500,
    ]);
    expect(
      await failure(postWebhook('slack', `${hook.url}/redirect`, message, { outbound })),
    ).toEqual(['rejected', 302]);
    expect(
      await failure(
        postWebhook('slack', `${hook.url}/slow`, message, { outbound, timeoutMs: 200 }),
      ),
    ).toEqual(['timeout', null]);
  });

  it('never puts the webhook URL in an error', async () => {
    // Nothing listens on port 1: the connection fails inside the HTTP client.
    const error = await postWebhook('slack', 'http://127.0.0.1:1/secret-token-xyz', message, {
      outbound,
    }).catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ name: 'DeliveryError', code: 'unreachable' });
    expect(`${(error as Error).message} ${(error as Error).stack}`).not.toContain('secret-token');
  });

  it('never reaches a private address that is not allowlisted (literal or rebinding)', async () => {
    const before = hook.posts.length;
    expect(
      await failure(
        postWebhook('slack', `${hook.url}/x`, message, { outbound: { allowedPrivateHosts: [] } }),
      ),
    ).toEqual(['blocked_url', null]);
    const port = new URL(hook.url).port;
    expect(
      await failure(
        postWebhook('slack', `http://hooks.rebind.example:${port}/x`, message, {
          outbound: { allowedPrivateHosts: [], resolve: async () => ['127.0.0.1'] },
        }),
      ),
    ).toEqual(['blocked_url', null]);
    // https too: the pinned connection refuses the rebound address at connect time.
    expect(
      await failure(
        postWebhook('slack', `https://hooks.rebind.example:${port}/x`, message, {
          outbound: { allowedPrivateHosts: [], resolve: async () => ['127.0.0.1'] },
        }),
      ),
    ).toEqual(['blocked_url', null]);
    expect(hook.posts.length).toBe(before);
  });

  it('reports each failure to onError with its code (for logging error names)', async () => {
    const onError = vi.fn();
    await postWebhook('slack', 'http://127.0.0.1:1/x', message, { outbound, onError }).catch(
      () => undefined,
    );
    expect(onError).toHaveBeenCalledOnce();
    const [error, code] = onError.mock.calls[0] ?? [];
    expect(code).toBe('unreachable');
    expect(typeof (error as Error).name).toBe('string');
    onError.mockClear();
    await postWebhook('slack', `${hook.url}/fail`, message, { outbound, onError }).catch(
      () => undefined,
    );
    expect(onError).toHaveBeenCalledWith(expect.any(DeliveryError), 'rejected');
  });

  it('re-checks the plaintext rule when sending: http only to allowlisted hosts', async () => {
    const send = vi.fn<typeof fetch>();
    expect(
      await failure(
        sendWebhook('teams', 'http://hooks.example.com/workflow', message, {
          outbound: { allowedPrivateHosts: [], resolve: async () => ['93.184.216.34'] },
          fetch: send,
        }),
      ),
    ).toEqual(['insecure_transport', null]);
    expect(send).not.toHaveBeenCalled();
    // The same host over https goes out (through the injected client here).
    send.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await sendWebhook('teams', 'https://hooks.example.com/workflow', message, {
      outbound: { allowedPrivateHosts: [], resolve: async () => ['93.184.216.34'] },
      fetch: send,
    });
    expect(send).toHaveBeenCalledOnce();
  });
});

describe('public surface', () => {
  it('offers no way to swap the pinned HTTP client outside tests', async () => {
    const notify = await import('./index');
    expect(notify).not.toHaveProperty('sendWebhook');
  });
});
