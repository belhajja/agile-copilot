import {
  createOutboundFetch,
  isAllowlistedHost,
  isBlockedAddressError,
  normalizeHost,
  type OutboundPolicy,
  RedirectBlockedError,
  withDeadline,
} from '@agile/net';
import { resolvePinnedAddress } from './email';
import { DeliveryError } from './errors';

/** A message for a chat channel: plain text, never fetched or unfurled by us or the platform. */
export interface ChannelMessage {
  title: string;
  text: string;
  /** A link back to the app (shown as a plain URL; the platform does not unfurl it). */
  link?: string;
}

const SLACK_TEXT_MAX = 2_900;
const TEAMS_TEXT_MAX = 20_000;

const cut = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/**
 * Slack's three control characters, escaped: model output (fed with Jira text) can then neither
 * ping `<!channel>`/`<@user>` nor disguise a link as `<https://evil|Open the report>`.
 */
export const escapeSlack = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Teams renders a Markdown subset in Adaptive Card text, including `[label](url)` links. Square
 * brackets become their full-width look-alikes, which no Markdown parser reads as link, image or
 * reference syntax (backslash escapes are not reliably honoured by Teams): model output cannot
 * disguise a link or embed an image. Bare URLs stay visible as they are.
 */
export const escapeTeams = (text: string) => text.replace(/\[/g, '［').replace(/\]/g, '］');

/** Slack incoming-webhook payload. Link and media unfurling are off: nothing is fetched. */
export function slackPayload(m: ChannelMessage) {
  const body = cut(escapeSlack(m.text), SLACK_TEXT_MAX);
  return {
    text: escapeSlack(m.title),
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: cut(m.title, 150), emoji: false } },
      { type: 'section', text: { type: 'mrkdwn', text: body || ' ' } },
      ...(m.link
        ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: escapeSlack(m.link) }] }]
        : []),
    ],
  };
}

/** Teams (Workflows "post to a channel when a webhook request is received"): an Adaptive Card. */
export function teamsPayload(m: ChannelMessage) {
  const block = (text: string, extra: Record<string, unknown> = {}) => ({
    type: 'TextBlock',
    text,
    wrap: true,
    ...extra,
  });
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            block(cut(escapeTeams(m.title), 150), { weight: 'Bolder', size: 'Medium' }),
            block(cut(escapeTeams(m.text), TEAMS_TEXT_MAX)),
            ...(m.link ? [block(m.link, { isSubtle: true })] : []),
          ],
        },
      },
    ],
  };
}

/**
 * Plaintext (`http://`) only towards the operator's allowlisted internal hosts, checked on every
 * send: the allowlist may have changed since the channel was saved. A host that resolves to a
 * private address is reported as `blocked_url` (like the SMTP check), any other as
 * `insecure_transport`; either way nothing is sent.
 */
async function assertTransportAllowed(url: URL, outbound: OutboundPolicy) {
  if (url.protocol !== 'http:') return;
  const host = normalizeHost(url.hostname);
  if (isAllowlistedHost(host, outbound.allowedPrivateHosts)) return;
  try {
    await resolvePinnedAddress(host, outbound);
  } catch (e) {
    throw new DeliveryError(isBlockedAddressError(e) ? 'blocked_url' : 'unreachable');
  }
  throw new DeliveryError('insecure_transport');
}

/** Any failure → a code. The URL (a secret) and the platform's answer never reach the error. */
function deliveryErrorOf(e: unknown): DeliveryError {
  if (e instanceof DeliveryError) return e;
  if (isBlockedAddressError(e)) return new DeliveryError('blocked_url');
  if (e instanceof RedirectBlockedError) return new DeliveryError('rejected', e.status);
  if ((e as { name?: string } | null)?.name === 'TimeoutError') return new DeliveryError('timeout');
  return new DeliveryError('unreachable');
}

/**
 * Posts to a Slack or Teams incoming webhook. The URL is user-supplied: the request goes through
 * the DNS-pinned outbound fetch (SSRF policy at connect time, no redirects) under one overall
 * deadline (resolution, connection, answer). Only the status code of the answer is used.
 */
export async function postWebhook(
  kind: 'slack' | 'teams',
  url: string,
  message: ChannelMessage,
  opts: { outbound: OutboundPolicy; timeoutMs?: number; fetch?: typeof fetch },
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const signal = AbortSignal.timeout(timeoutMs);
  const work = (async () => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new DeliveryError('blocked_url');
    }
    await assertTransportAllowed(target, opts.outbound);
    const send = opts.fetch ?? createOutboundFetch(opts.outbound);
    const res = await send(target.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(kind === 'slack' ? slackPayload(message) : teamsPayload(message)),
      signal,
    });
    // The answer's body is discarded unread: only the status matters.
    await res.body?.cancel().catch(() => undefined);
    return res.status;
  })();
  // If the deadline wins, the request is aborted through `signal`; swallow its late rejection.
  work.catch(() => undefined);
  let status: number;
  try {
    status = await withDeadline(work, timeoutMs, () => new DeliveryError('timeout'));
  } catch (e) {
    throw deliveryErrorOf(e);
  }
  if (status < 200 || status >= 300) throw new DeliveryError('rejected', status);
}
