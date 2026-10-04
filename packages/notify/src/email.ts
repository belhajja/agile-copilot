import {
  createPinnedLookup,
  isAllowlistedHost,
  isBlockedAddressError,
  normalizeHost,
  type OutboundPolicy,
} from '@agile/net';
import { createTransport } from 'nodemailer';
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
}

/**
 * Resolves the SMTP host once, through the same rule as every other user-supplied host
 * (`createPinnedLookup`): the address that passed is the one the connection uses. TLS still
 * verifies the certificate against the host name (`servername`).
 */
export function resolvePinnedAddress(host: string, outbound: OutboundPolicy): Promise<string> {
  const lookup = createPinnedLookup(outbound);
  return new Promise((resolve, reject) =>
    lookup(host, {}, (error, address) =>
      error ? reject(error) : resolve(typeof address === 'string' ? address : ''),
    ),
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

/** Connects (and logs in) without sending anything: the check when a channel is saved. */
export async function verifySmtp(secret: SmtpSecret, opts: SmtpOptions): Promise<void> {
  const transport = await transportFor(secret, opts);
  try {
    await transport.verify();
  } catch (e) {
    throw deliveryErrorOf(e);
  } finally {
    transport.close();
  }
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
  const transport = await transportFor(secret, opts);
  try {
    await transport.sendMail({
      from: secret.from,
      to: message.to,
      subject: message.subject.replace(/[\r\n]+/g, ' ').slice(0, 200),
      html: message.html,
      text: message.text,
      // No tracking, no remote content: the report is all there is.
      headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
    });
  } catch (e) {
    throw deliveryErrorOf(e);
  } finally {
    transport.close();
  }
}
