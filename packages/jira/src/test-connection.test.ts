import { describe, expect, it } from 'vitest';
import { testJiraConnection } from './test-connection';
import { startMockJira } from './testing/mock-jira-server';

const publicDns = async () => ['104.192.141.1'];

describe('testJiraConnection', () => {
  it('blocks private Jira URLs unless allowlisted', async () => {
    const r = await testJiraConnection(
      { kind: 'datacenter_pat', baseUrl: 'http://127.0.0.1:8080', token: 't' },
      { allowedPrivateHosts: [] },
    );
    expect(r).toMatchObject({ ok: false, code: 'blocked_url' });
  });

  it('requires https for Jira Cloud', async () => {
    const r = await testJiraConnection(
      { kind: 'cloud_basic', baseUrl: 'http://acme.atlassian.net', email: 'a@b.co', apiToken: 't' },
      { allowedPrivateHosts: [], resolve: publicDns },
    );
    expect(r).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('rejects input that is not a URL', async () => {
    const r = await testJiraConnection(
      { kind: 'datacenter_pat', baseUrl: 'jira', token: 't' },
      { allowedPrivateHosts: [] },
    );
    expect(r).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('probes an allowlisted private DC server with trimmed credentials', async () => {
    const mock = await startMockJira({
      flavor: 'datacenter',
      validAuthorization: 'Bearer good-pat',
    });
    try {
      const r = await testJiraConnection(
        { kind: 'datacenter_pat', baseUrl: `${mock.url}/browse/ABC-1`, token: '  good-pat\n' },
        { allowedPrivateHosts: ['127.0.0.1'] },
      );
      expect(r).toMatchObject({ ok: true, deployment: 'datacenter' });
    } finally {
      await mock.close();
    }
  });
});
