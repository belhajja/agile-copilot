import { describe, expect, it } from 'vitest';
import { checkOutboundUrl, type Resolver } from './outbound-url';

const resolveTo =
  (...ips: string[]): Resolver =>
  async () =>
    ips;
const opts = (resolve: Resolver, allowedPrivateHosts: string[] = []) => ({
  resolve,
  allowedPrivateHosts,
});

describe('checkOutboundUrl', () => {
  it('accepts a public https host', async () => {
    const r = await checkOutboundUrl(
      'https://acme.atlassian.net',
      opts(resolveTo('104.192.141.1')),
    );
    expect(r.ok).toBe(true);
  });

  it('treats a trailing-dot host as the allowlisted host', async () => {
    const r = await checkOutboundUrl('http://jira.corp.test./', {
      allowedPrivateHosts: ['corp.test'],
      resolve: resolveTo('10.0.0.5'),
    });
    expect(r.ok).toBe(true);
  });

  it.each([
    ['ftp://jira.example.com', /http/, 'scheme'],
    ['https://user:pw@jira.example.com', /credentials/, 'credentials'],
    ['not a url', /valid URL/, 'invalid_url'],
    ['http://localhost:8080', /private|localhost/, 'localhost'],
    ['http://metadata.google.internal', /blocked/, 'blocked_host'],
    ['http://metadata./', /blocked/, 'blocked_host'],
    ['http://metadata.google.internal./', /blocked/, 'blocked_host'],
  ])('rejects %s', async (url, reason, code) => {
    const r = await checkOutboundUrl(url, opts(resolveTo('8.8.8.8')));
    expect(r).toMatchObject({ ok: false, code, reason: expect.stringMatching(reason) });
  });

  it.each([
    '10.0.0.5',
    '192.168.1.10',
    '127.0.0.1',
    '169.254.169.254',
    '::1',
    '::ffff:10.0.0.1',
    'fd00::1',
  ])('rejects hosts resolving to %s', async (ip) => {
    const r = await checkOutboundUrl('https://jira.corp.example', opts(resolveTo('8.8.8.8', ip)));
    expect(r).toMatchObject({ ok: false, code: 'private_address', host: 'jira.corp.example' });
  });

  it('rejects private IP literals', async () => {
    expect(await checkOutboundUrl('http://10.1.2.3/jira', opts(resolveTo()))).toMatchObject({
      ok: false,
      code: 'private_address',
      host: '10.1.2.3',
    });
  });

  it('allows private hosts (and their subdomains) on the operator allowlist without DNS', async () => {
    const neverResolve: Resolver = async () => {
      throw new Error('should not resolve');
    };
    const r = await checkOutboundUrl(
      'http://jira.corp.local/jira',
      opts(neverResolve, ['corp.local']),
    );
    expect(r.ok).toBe(true);
  });

  it('reports unresolvable hosts', async () => {
    const failing: Resolver = async () => {
      throw new Error('ENOTFOUND');
    };
    expect(await checkOutboundUrl('https://nope.example', opts(failing))).toMatchObject({
      ok: false,
      code: 'unresolvable',
      host: 'nope.example',
      reason: expect.stringMatching(/resolve/),
    });
  });
});
