import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolvePinnedAddress, sendEmail, verifySmtp } from './email';
import { renderDigestEmail } from './email-template';
import { DeliveryError } from './errors';
import { type MockSmtp, startMockSmtp } from './testing';

const outbound = { allowedPrivateHosts: ['127.0.0.1', 'mail.corp.test'] };

describe('email over SMTP (in-process server)', () => {
  let open: MockSmtp;
  let authed: MockSmtp;
  beforeAll(async () => {
    open = await startMockSmtp();
    authed = await startMockSmtp({ auth: { user: 'bot', pass: 's3cret' } });
  });
  afterAll(async () => {
    await open?.close();
    await authed?.close();
  });

  const secret = (port: number, extra: Record<string, unknown> = {}) => ({
    host: '127.0.0.1',
    port,
    security: 'none' as const,
    from: 'copilot@example.com',
    ...extra,
  });
  const failure = (p: Promise<unknown>) =>
    p.then(
      () => 'no error',
      (e: unknown) => (e instanceof DeliveryError ? e.code : `other: ${(e as Error).name}`),
    );

  it('renders a digest with no remote content, the report escaped as text', async () => {
    const { html, text } = await renderDigestEmail({
      lang: 'fr',
      title: 'Rapport : sprint-digest',
      body: 'Sprint on track.\n\n<script>alert(1)</script> ![x](https://evil.example/p.png)',
      link: 'http://localhost:3200/skills',
      linkLabel: 'Ouvrir dans Agile Copilot',
      footer: 'Vous recevez ce message…',
    });
    expect(html).toContain('<html lang="fr"');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toMatch(/<script|<img|<link|url\(/i);
    expect(text).toContain('Sprint on track.');
    expect(text).toContain('Vous recevez ce message');
  });

  it('sends through the pinned connection, with sender, recipient and both bodies', async () => {
    await sendEmail(
      secret(open.port),
      {
        to: 'pat@example.com',
        subject: 'Report:\r\nBcc: x@evil.example',
        html: '<p>Hi</p>',
        text: 'Hi',
      },
      { outbound },
    );
    const mail = open.mails.at(-1);
    expect(mail?.from).toBe('copilot@example.com');
    expect(mail?.to).toEqual(['pat@example.com']);
    expect(mail?.raw).toMatch(/^Subject: Report: Bcc: x@evil\.example\r?$/m);
    expect(mail?.raw).not.toMatch(/^Bcc:/m);
    expect(mail?.raw).toMatch(/Auto-Submitted: auto-generated/);
    expect(mail?.raw).toMatch(/text\/html/);
    expect(mail?.raw).toMatch(/text\/plain/);
  });

  it('logs in when the server requires it, and reports a bad login as auth_failed', async () => {
    await verifySmtp(secret(authed.port, { username: 'bot', password: 's3cret' }), { outbound });
    expect(
      await failure(
        verifySmtp(secret(authed.port, { username: 'bot', password: 'wrong' }), { outbound }),
      ),
    ).toBe('auth_failed');
  });

  it('never connects to a private address that is not allowlisted', async () => {
    const before = open.connections();
    expect(
      await failure(verifySmtp(secret(open.port), { outbound: { allowedPrivateHosts: [] } })),
    ).toBe('blocked_url');
    // A host that resolves publicly at save time and to 127.0.0.1 now (DNS rebinding).
    expect(
      await failure(
        sendEmail(
          { ...secret(open.port), host: 'smtp.rebind.example' },
          { to: 'a@example.com', subject: 's', html: 'h', text: 't' },
          { outbound: { allowedPrivateHosts: [], resolve: async () => ['127.0.0.1'] } },
        ),
      ),
    ).toBe('blocked_url');
    expect(open.connections()).toBe(before);
  });

  it('refuses plaintext SMTP to a host that is not allowlisted, at send time (P4-R14)', async () => {
    const before = open.connections();
    // The host passed the save-time check (public address); the channel was stored with
    // security "none" (or edited since): sending still refuses to speak plaintext to it.
    const publicHost = {
      ...secret(open.port),
      host: 'smtp.public.example',
    };
    const policy = { allowedPrivateHosts: [], resolve: async () => ['93.184.216.34'] };
    expect(
      await failure(
        sendEmail(
          publicHost,
          { to: 'a@example.com', subject: 's', html: 'h', text: 't' },
          { outbound: policy },
        ),
      ),
    ).toBe('insecure_transport');
    expect(await failure(verifySmtp(publicHost, { outbound: policy }))).toBe('insecure_transport');
    // A parent-domain allowlist entry covers its subdomains, like everywhere else.
    expect(
      await failure(
        verifySmtp(
          { ...secret(open.port), host: 'relay.corp.test' },
          { outbound: { allowedPrivateHosts: ['corp.test'], resolve: async () => ['127.0.0.1'] } },
        ),
      ),
    ).toBe('no error');
    expect(open.connections()).toBe(before + 1);
  });

  it('connects to an allowlisted internal host name at the address it resolved', async () => {
    await verifySmtp(
      { ...secret(open.port), host: 'mail.corp.test' },
      { outbound: { ...outbound, resolve: async () => ['127.0.0.1'] } },
    );
  });

  it('reports an unreachable server with a code', async () => {
    expect(await failure(verifySmtp(secret(1), { outbound, timeoutMs: 2_000 }))).toBe(
      'unreachable',
    );
  });

  it('requires TLS when asked to: a server without STARTTLS is refused', async () => {
    expect(
      await failure(verifySmtp(secret(open.port, { security: 'starttls' }), { outbound })),
    ).toBe('unreachable');
  });

  const message = { to: 'pat@example.com', subject: 's', html: 'h', text: 't' };

  it('gives up on a server that stalls, within the overall deadline', async () => {
    const stalled = await startMockSmtp({ stallData: true });
    try {
      const started = Date.now();
      expect(
        await failure(
          sendEmail(secret(stalled.port), message, {
            outbound,
            timeoutMs: 30_000,
            deadlineMs: 500,
          }),
        ),
      ).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await stalled.close();
    }
  });

  it('reports a refused recipient as rejected', async () => {
    const strict = await startMockSmtp({ rejectRecipients: true });
    try {
      expect(await failure(sendEmail(secret(strict.port), message, { outbound }))).toBe('rejected');
    } finally {
      await strict.close();
    }
  });

  it('sends to exactly one recipient from exactly one sender, validated before connecting', async () => {
    const before = open.connections();
    const bad = [
      'pat@example.com\r\nBcc: x@evil.example',
      'pat@example.com, x@evil.example',
      'pat@example.com;x@evil.example',
      'Pat <pat@example.com>',
      'not-an-address',
    ];
    for (const to of bad) {
      expect(await failure(sendEmail(secret(open.port), { ...message, to }, { outbound }))).toBe(
        'rejected',
      );
    }
    expect(
      await failure(
        sendEmail(secret(open.port, { from: 'a@example.com\nBcc: x@evil.example' }), message, {
          outbound,
        }),
      ),
    ).toBe('rejected');
    expect(open.connections()).toBe(before);
  });

  it('refuses a non-string pinned address', async () => {
    await expect(
      resolvePinnedAddress('mail.corp.test', {
        allowedPrivateHosts: ['mail.corp.test'],
        resolve: async () => [],
      }),
    ).rejects.toThrow();
  });

  it('refuses an untrusted TLS certificate while connecting to the pinned address', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notify-tls-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=mail.corp.test',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    const secure = await startMockSmtp({
      tls: {
        key: readFileSync(join(dir, 'key.pem'), 'utf8'),
        cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
      },
    });
    try {
      // "mail.corp.test" resolves nowhere: only the pinned address can reach the server.
      expect(
        await failure(
          sendEmail({ ...secret(secure.port), host: 'mail.corp.test', security: 'tls' }, message, {
            outbound: { ...outbound, resolve: async () => ['127.0.0.1'] },
          }),
        ),
      ).toBe('unreachable');
      expect(secure.mails).toHaveLength(0);
      await vi.waitFor(() => expect(secure.tlsClientErrors()).toBe(1));
    } finally {
      await secure.close();
    }
  });
});
