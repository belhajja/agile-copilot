import type { AddressInfo, Socket } from 'node:net';
import { simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';

export interface CapturedMail {
  from: string;
  to: string[];
  /** The raw RFC 822 message (headers + MIME body). */
  raw: string;
  /** Decoded by mailparser (quoted-printable, charsets). */
  subject: string;
  text: string;
  html: string;
}

/**
 * An in-process SMTP server (Nodemailer's smtp-server) that keeps what it receives: for unit
 * tests and the e2e mocks. Plain SMTP (no TLS) on 127.0.0.1; `auth` makes it require a login.
 */
export async function startMockSmtp(
  opts: {
    auth?: { user: string; pass: string };
    /** Accept the connection and the envelope, then never finish DATA (a stalled server). */
    stallData?: boolean;
    /** Refuse every recipient (550). */
    rejectRecipients?: boolean;
    /** Implicit TLS with this key/certificate (tests use a self-signed one). */
    tls?: { key: string; cert: string };
  } = {},
) {
  const mails: CapturedMail[] = [];
  let connections = 0;
  let tlsClientErrors = 0;
  const server = new SMTPServer({
    secure: Boolean(opts.tls),
    ...(opts.tls ? { key: opts.tls.key, cert: opts.tls.cert } : {}),
    disabledCommands: opts.auth ? ['STARTTLS'] : ['STARTTLS', 'AUTH'],
    authOptional: !opts.auth,
    allowInsecureAuth: true,
    logger: false,
    onConnect(_session, callback) {
      connections++;
      callback();
    },
    onRcptTo(_address, _session, callback) {
      callback(opts.rejectRecipients ? new Error('550 Mailbox unavailable') : null);
    },
    onAuth(auth, _session, callback) {
      if (opts.auth && auth.username === opts.auth.user && auth.password === opts.auth.pass) {
        callback(null, { user: auth.username });
      } else callback(new Error('Invalid username or password'));
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', async () => {
        if (opts.stallData) return;
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          const parsed = await simpleParser(raw);
          mails.push({
            from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
            to: session.envelope.rcptTo.map((r) => r.address),
            raw,
            subject: parsed.subject ?? '',
            text: parsed.text ?? '',
            html: typeof parsed.html === 'string' ? parsed.html : '',
          });
          callback();
        } catch (error) {
          callback(error as Error);
        }
      });
    },
  });
  const sockets = new Set<Socket>();
  server.server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  // smtp-server reports an abandoned TLS handshake as a server 'error' (and throws without a listener).
  server.on('error', () => {
    tlsClientErrors++;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.server.address() as AddressInfo).port;
  return {
    port,
    mails,
    connections: () => connections,
    /** TLS handshakes the client abandoned (e.g. an untrusted certificate). */
    tlsClientErrors: () => tlsClientErrors,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // A stalled client would otherwise keep close() waiting.
        for (const socket of sockets) socket.destroy();
      }),
  };
}

export type MockSmtp = Awaited<ReturnType<typeof startMockSmtp>>;
