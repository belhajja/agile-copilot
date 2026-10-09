import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendEmail } from './email';
import { renderDigestEmail } from './email-template';
import { MAILPIT_IMAGE } from './testing';

/** A real SMTP server (Mailpit): the digest arrives as a well-formed multipart message. */
describe('email contract (Mailpit)', () => {
  let mailpit: StartedTestContainer;
  beforeAll(async () => {
    mailpit = await new GenericContainer(MAILPIT_IMAGE)
      .withExposedPorts(1025, 8025)
      .withWaitStrategy(Wait.forHttp('/livez', 8025))
      .start();
  });
  afterAll(async () => {
    await mailpit?.stop();
  });

  it('delivers the digest with its subject, recipient, HTML and text parts', async () => {
    const host = mailpit.getHost();
    const { html, text } = await renderDigestEmail({
      lang: 'en',
      title: 'Report: sprint-digest',
      body: 'Sprint DEMO-12 is at risk: 3 stories are blocked.',
      link: 'https://copilot.example.com/skills',
      linkLabel: 'Open in Agile Copilot',
      footer: 'You receive this because you own the skill “sprint-digest”.',
    });
    await sendEmail(
      { host, port: mailpit.getMappedPort(1025), security: 'none', from: 'copilot@example.com' },
      { to: 'pat@example.com', subject: 'Report: sprint-digest', html, text },
      // The container answers on a local address and a mapped port (not a loopback one on the CI
      // runner): the test allowlists both, like an operator would.
      { outbound: { allowedPrivateHosts: [host] }, ports: [mailpit.getMappedPort(1025)] },
    );
    const api = `http://${host}:${mailpit.getMappedPort(8025)}/api/v1`;
    const listRes = await fetch(`${api}/messages`);
    expect(listRes.ok).toBe(true);
    const list = (await listRes.json()) as {
      messages: { ID: string; Subject: string; To: { Address: string }[] }[];
    };
    expect(list.messages.map((m) => [m.Subject, m.To.map((t) => t.Address)])).toEqual([
      ['Report: sprint-digest', ['pat@example.com']],
    ]);
    const messageRes = await fetch(`${api}/message/${list.messages[0]?.ID}`);
    expect(messageRes.ok).toBe(true);
    const message = (await messageRes.json()) as {
      From: { Address: string };
      HTML: string;
      Text: string;
    };
    expect(message.From.Address).toBe('copilot@example.com');
    expect(message.HTML).toContain('3 stories are blocked.');
    expect(message.Text).toContain('3 stories are blocked.');
    expect(message.HTML).not.toMatch(/<img|<script/i);
  });
});
