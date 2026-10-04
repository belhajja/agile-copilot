import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockJiraOptions {
  flavor: 'cloud' | 'datacenter';
  /** Exact Authorization header value that is accepted, e.g. "Bearer good-pat". */
  validAuthorization: string;
  /** e.g. "/jira" (DC context path) or "/ex/jira/cloud-123" (OAuth gateway). */
  pathPrefix?: string;
}

export interface MockJira {
  url: string;
  requests: { path: string; authorization?: string }[];
  close(): Promise<void>;
}

const CLOUD_MYSELF = {
  self: 'https://acme.atlassian.net/rest/api/3/user?accountId=acc-1',
  accountId: 'acc-1',
  accountType: 'atlassian',
  emailAddress: 'pm@acme.com',
  displayName: 'Pat Cloud',
  active: true,
  timeZone: 'Europe/Paris',
  locale: 'en_US',
  avatarUrls: {},
};
const CLOUD_SERVER_INFO = {
  baseUrl: 'https://acme.atlassian.net',
  version: '1001.0.0-SNAPSHOT',
  versionNumbers: [1001, 0, 0],
  deploymentType: 'Cloud',
  buildNumber: 100,
  buildDate: '2026-09-30T00:00:00.000+0000',
  serverTime: '2026-10-03T00:00:00.000+0000',
  scmInfo: 'abc',
  serverTitle: 'Jira',
  defaultLocale: { locale: 'en_US' },
};
const DC_MYSELF = { self: 'x', key: 'JIRAUSER1', name: 'pat', displayName: 'Pat DC', active: true };
const DC_SERVER_INFO = {
  baseUrl: 'https://jira.corp.example',
  version: '10.3.0',
  versionNumbers: [10, 3, 0],
  deploymentType: 'Server',
  buildNumber: 10030000,
  serverTitle: 'Corp Jira',
};

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export async function startMockJira(opts: MockJiraOptions): Promise<MockJira> {
  const api = opts.flavor === 'cloud' ? '3' : '2';
  const prefix = opts.pathPrefix ?? '';
  const requests: MockJira['requests'] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    requests.push({ path, authorization: req.headers.authorization });
    if (req.headers.authorization !== opts.validAuthorization) {
      return json(res, 401, { errorMessages: ['You are not authenticated.'] });
    }
    if (path === `${prefix}/rest/api/${api}/myself`) {
      return json(res, 200, opts.flavor === 'cloud' ? CLOUD_MYSELF : DC_MYSELF);
    }
    if (path === `${prefix}/rest/api/${api}/serverInfo`) {
      return json(res, 200, opts.flavor === 'cloud' ? CLOUD_SERVER_INFO : DC_SERVER_INFO);
    }
    json(res, 404, { errorMessages: ['Not found'] });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${prefix}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // Clients keep connections alive; without this close() waits for the keep-alive timeout.
        server.closeAllConnections();
      }),
  };
}
