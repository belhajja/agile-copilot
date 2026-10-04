import type { Resolver } from '@agile/net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJiraDataSource } from './data-source';
import { mapJiraError } from './errors';
import { testJiraConnection } from './test-connection';
import { demoDataset, type MockJira, startMockJira } from './testing/mock-jira-server';

/** Public for the URL check, then the local mock (a DNS rebinding attack) for every later lookup. */
const rebinding = (): Resolver => {
  let calls = 0;
  return async () => (calls++ === 0 ? ['93.184.216.34'] : ['127.0.0.1']);
};

describe('Jira requests are pinned to the address that passed the URL policy', () => {
  let dc: MockJira;
  let cloud: MockJira;
  beforeAll(async () => {
    dc = await startMockJira({ flavor: 'datacenter', validAuthorization: 'Bearer pat' });
    cloud = await startMockJira({
      flavor: 'cloud',
      validAuthorization: `Basic ${Buffer.from('pm@acme.com:tok').toString('base64')}`,
      dataset: demoDataset(new Date('2026-10-04T00:00:00Z')),
    });
  });
  afterAll(async () => {
    await dc?.close();
    await cloud?.close();
  });
  const rebound = (mock: MockJira) => mock.url.replace('127.0.0.1', 'jira.rebind.example');

  it('Data Center test connection (jira.js v5 / axios) refuses the rebound address', async () => {
    const result = await testJiraConnection(
      { kind: 'datacenter_pat', baseUrl: rebound(dc), token: 'pat' },
      { allowedPrivateHosts: [], resolve: rebinding() },
    );
    expect(result).toMatchObject({ ok: false, code: 'blocked_url' });
    expect(dc.requests).toEqual([]);
  });

  it('Cloud API-token data source (fetch) refuses the rebound address', async () => {
    const source = createJiraDataSource(
      { kind: 'cloud_basic', baseUrl: rebound(cloud), email: 'pm@acme.com', apiToken: 'tok' },
      { outbound: { allowedPrivateHosts: [], resolve: async () => ['127.0.0.1'] } },
    );
    const error = await source.listBoards().catch((e: unknown) => e);
    expect(mapJiraError(error).code).toBe('blocked_url');
    expect(cloud.requests).toEqual([]);
  });

  it('Data Center data source blocked mid-sync maps to blocked_url without leaking axios config', async () => {
    const source = createJiraDataSource(
      { kind: 'datacenter_pat', baseUrl: rebound(dc), token: 'pat' },
      { outbound: { allowedPrivateHosts: [], resolve: async () => ['127.0.0.1'] } },
    );
    const error = await source.listBoards().catch((e: unknown) => e);
    expect(mapJiraError(error).code).toBe('blocked_url');
    expect(error).toMatchObject({ name: 'BlockedAddressError' });
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('pat');
    expect(dc.requests).toEqual([]);
  });

  it('still reaches allowlisted private hosts', async () => {
    const result = await testJiraConnection(
      { kind: 'datacenter_pat', baseUrl: dc.url, token: 'pat' },
      { allowedPrivateHosts: ['127.0.0.1'] },
    );
    expect(result).toMatchObject({ ok: true, deployment: 'datacenter' });
  });
});
