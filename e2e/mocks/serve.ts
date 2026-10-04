import { createServer, request } from 'node:http';
import { demoDataset, type MockJira, startMockJira } from '@agile/jira/testing';
import { startMockMcpAtlassian } from '@agile/jira-tools/testing';
import { startMockOpenAI } from '@agile/llm/testing';

// The mocks listen on random ports; expose them on fixed ports via a tiny reverse proxy.
// `jira` answers GET /__mock/writes itself (what the agent wrote to Jira, for assertions).
async function expose(port: number, target: string, jira?: MockJira) {
  const t = new URL(target);
  const server = createServer((req, res) => {
    if (jira && req.method === 'GET' && req.url === '/__mock/writes') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(jira.writes));
      return;
    }
    const upstream = request(
      { host: t.hostname, port: t.port, path: req.url, method: req.method, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
}

// Data Center flavour with the demo boards (dates relative to today) for the sync and dashboard tests.
const jira = await startMockJira({
  flavor: 'datacenter',
  validAuthorization: 'Bearer good-pat',
  dataset: demoDataset(new Date()),
});
// Scripted tool-calling model (see agentDemoScript) for the connection test and the agent tests.
const llm = await startMockOpenAI({ validKey: 'good-key' });
// Stand-in for the shared mcp-atlassian instance: same tools and headers, writes reach the mock Jira.
const mcp = await startMockMcpAtlassian({ allowedHosts: ['127.0.0.1'] });
// 4010 is Playwright's readiness port for this process, so it opens last: once it answers, the
// model (4020) and the mcp-atlassian double (4050) are already listening.
await expose(4020, new URL(llm.baseUrl).origin);
await expose(4050, new URL(mcp.url).origin);
await expose(4010, jira.url, jira);
console.log(
  'mocks ready: jira http://127.0.0.1:4010, llm http://127.0.0.1:4020/v1, mcp-atlassian http://127.0.0.1:4050/mcp',
);
