import type { AddressInfo } from 'node:net';
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
export async function startMockSmtp(opts: { auth?: { user: string; pass: string } } = {}) {
  const mails: CapturedMail[] = [];
  let connections = 0;
  const server = new SMTPServer({
    secure: false,
    disabledCommands: opts.auth ? ['STARTTLS'] : ['STARTTLS', 'AUTH'],
    authOptional: !opts.auth,
    allowInsecureAuth: true,
    logger: false,
    onConnect(_session, callback) {
      connections++;
      callback();
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
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.server.address() as AddressInfo).port;
  return {
    port,
    mails,
    connections: () => connections,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type MockSmtp = Awaited<ReturnType<typeof startMockSmtp>>;
