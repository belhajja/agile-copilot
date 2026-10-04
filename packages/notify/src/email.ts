import {
  createPinnedLookup,
  isAllowlistedHost,
  isBlockedAddressError,
  normalizeHost,
  type OutboundPolicy,
  withDeadline,
} from '@agile/net';
import { createTransport, type Transporter } from 'nodemailer';
import { DeliveryError } from './errors';

/** A workspace's SMTP server (stored encrypted in its delivery channel). */
export interface SmtpSecret {
  host: string;
  port: number;
  /** `tls`: implicit TLS (465); `starttls`: upgrade required (587); `none`: internal relays only. */
  security: 'tls' | 'starttls' | 'none';
  username?: string;
  password?: string;
  from: string;
}

export interface SmtpOptions {
  outbound: OutboundPolicy;
  /** Connection, greeting and socket deadlines (ms). Default 15 s. */
  timeoutMs?: number;
  /** Total time for the whole operation, name resolution included (ms). Default 60 s. */
  deadlineMs?: number;
}

/** One address, nothing else: no separators, no control characters, no display name. */
const ADDRESS = /^[^\s@,;<>"()[\]\\:]+@[^\s@,;<>"()[\]\\:]+\.[^\s@,;<>"()[\]\\:]+$/;
export const isSingleAddress = (value: string) => value.length <= 254 && ADDRESS.test(value);

/**
 * Resolves the SMTP host once, through the same rule as every other user-supplied host
 * (`createPinnedLookup`): the address that passed is the one the connection uses. TLS still
 * verifies the certificate against the host name (`servername`).
 */
export function resolvePinnedAddress(host: string, outbound: OutboundPolicy): Promise<string> {
  const lookup = createPinnedLookup(outbound);
  return new Promise((resolve, reject) =>
    lookup(host, {}, (error, address) => {
      if (error) return reject(error);
      if (typeof address !== 'string' || address === '')
        return reject(Object.assign(new Error(`Could not resolve ${host}`), { code: 'ENOTFOUND' }));
      resolve(address);
    }),
  );
}

async function transportFor(secret: SmtpSecret, opts: SmtpOptions) {
  let address: string;
  try {
    address = await resolvePinnedAddress(secret.host, opts.outbound);
  } catch (e) {
    throw new DeliveryError(isBlockedAddressError(e) ? 'blocked_url' : 'unreachable');
  }
  // Plaintext SMTP only to the operator's allowlisted internal hosts. Checked here, on every
  // connection (not only when the channel is saved): the stored security or the allowlist may
  // have changed since.
  if (
    secret.security === 'none' &&
    !isAllowlistedHost(normalizeHost(secret.host), opts.outbound.allowedPrivateHosts)
  ) {
    throw new DeliveryError('insecure_transport');
  }
  const timeout = opts.timeoutMs ?? 15_000;
  return createTransport({
    host: address,
    port: secret.port,
    secure: secret.security === 'tls',
    requireTLS: secret.security === 'starttls',
    ignoreTLS: secret.security === 'none',
    servername: secret.host,
    tls: { servername: secret.host, minVersion: 'TLSv1.2' },
    auth: secret.username ? { user: secret.username, pass: secret.password ?? '' } : undefined,
    name: 'agile-copilot',
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
    logger: false,
    debug: false,
  });
}

/** nodemailer error codes → our delivery codes (the message, which can echo server text, is dropped). */
function deliveryErrorOf(e: unknown): DeliveryError {
  if (e instanceof DeliveryError) return e;
  const code = (e as { code?: string } | null)?.code;
  if (code === 'EAUTH' || code === 'ENOAUTH') return new DeliveryError('auth_failed');
  if (code === 'ETIMEDOUT') return new DeliveryError('timeout');
  if (code === 'EENVELOPE' || code === 'EMESSAGE') return new DeliveryError('rejected');
  if (isBlockedAddressError(e)) return new DeliveryError('blocked_url');
  return new DeliveryError('unreachable');
}

/**
 * Runs `action` on a fresh transport under one overall deadline (resolution, connection, login and
 * the exchange itself): per-socket timeouts do not stop a server that trickles bytes.
 */
async function withTransport(
  secret: SmtpSecret,
  opts: SmtpOptions,
  action: (transport: Transporter) => Promise<unknown>,
): Promise<void> {
  let transport: Transporter | undefined;
  const work = (async () => {
    transport = await transportFor(secret, opts);
    await action(transport);
  })();
  // If the deadline wins, the work may still finish later: close whatever it opened then.
  const closeLate = () => transport?.close();
  work.then(closeLate, closeLate);
  try {
    await withDeadline(work, opts.deadlineMs ?? 60_000, () => new DeliveryError('timeout'));
  } catch (e) {
    throw deliveryErrorOf(e);
  } finally {
    transport?.close();
  }
}

/** Connects (and logs in) without sending anything: the check when a channel is saved. */
export async function verifySmtp(secret: SmtpSecret, opts: SmtpOptions): Promise<void> {
  await withTransport(secret, opts, (transport) => transport.verify());
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Sends one email through the workspace's SMTP server. */
export async function sendEmail(
  secret: SmtpSecret,
  message: EmailMessage,
  opts: SmtpOptions,
): Promise<void> {
  // Exactly one sender and one recipient, checked before anything is resolved or opened.
  if (!isSingleAddress(secret.from) || !isSingleAddress(message.to))
    throw new DeliveryError('rejected');
  await withTransport(secret, opts, (transport) =>
    transport.sendMail({
      from: secret.from,
      to: message.to,
      envelope: { from: secret.from, to: [message.to] },
      subject: message.subject.replace(/[\r\n]+/g, ' ').slice(0, 200),
      html: message.html,
      text: message.text,
      // No tracking, no remote content: the report is all there is.
      headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
    }),
  );
}
