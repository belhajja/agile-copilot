import { createServer, type IncomingMessage, request, type ServerResponse } from 'node:http';
import { demoDataset, startMockJira } from '@agile/jira/testing';
import { startMockMcpAtlassian } from '@agile/jira-tools/testing';
import { startMockOpenAI } from '@agile/llm/testing';
import { startMockSmtp, startMockWebhook } from '@agile/notify/testing';

/** Answers GET requests on these paths itself (test assertions) instead of proxying them. */
type Inspect = Record<string, () => unknown>;

/** Forwards one request to `target` (an origin), with the path `path`. */
function forward(req: IncomingMessage, res: ServerResponse, target: string, path: string) {
  const t = new URL(target);
  const upstream = request(
    { host: t.hostname, port: t.port, path, method: req.method, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502).end();
  });
  req.pipe(upstream);
}

/**
 * The mocks listen on random ports; expose them on fixed ports via a tiny reverse proxy. `route`
 * picks the upstream origin and path for a request path (default: `target`, same path).
 */
async function expose(
  port: number,
  target: string,
  opts: { inspect?: Inspect; route?: (path: string) => { target: string; path: string } } = {},
) {
  const server = createServer((req, res) => {
    const read = req.method === 'GET' ? opts.inspect?.[req.url ?? ''] : undefined;
    if (read) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(read()));
      return;
    }
    const to = opts.route?.(req.url ?? '/') ?? { target, path: req.url ?? '/' };
    forward(req, res, to.target, to.path);
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
// Stand-ins for the shared mcp-atlassian instance (chat, read-write) and its read-only twin (skill
// runs and previews): same tools and headers, calls reach the mock Jira. The twin serves only the
// catalog's read tools, like the real one with READ_ONLY_MODE=true.
const mcp = await startMockMcpAtlassian({ allowedHosts: ['127.0.0.1'] });
const mcpReadonly = await startMockMcpAtlassian({ allowedHosts: ['127.0.0.1'], readOnly: true });
// Skill deliveries: an SMTP server (4070) and a Slack/Teams webhook receiver (4080), fixed ports.
const smtp = await startMockSmtp({ port: 4070 });
const hook = await startMockWebhook({ port: 4080 });

// Both doubles share port 4050: /mcp is the read-write instance (MCP_ATLASSIAN_URL) and
// /readonly/mcp the twin (MCP_ATLASSIAN_READONLY_URL).
const READONLY_PREFIX = '/readonly';
await expose(4020, new URL(llm.baseUrl).origin);
await expose(4050, new URL(mcp.url).origin, {
  route: (path) =>
    path.startsWith(`${READONLY_PREFIX}/`)
      ? { target: new URL(mcpReadonly.url).origin, path: path.slice(READONLY_PREFIX.length) }
      : { target: new URL(mcp.url).origin, path },
});
// 4010 is Playwright's readiness port for this process, so it opens last: once it answers, the
// model (4020), the mcp-atlassian doubles (4050), SMTP (4070) and webhooks (4080) are listening.
// It also answers, for assertions: what the agent wrote to Jira, the emails the SMTP mock received,
// the Slack/Teams posts and the tool calls each mcp-atlassian double served (names and Jira URL).
await expose(4010, jira.url, {
  inspect: {
    '/__mock/writes': () => jira.writes,
    '/__mock/mail': () =>
      smtp.mails.map(({ from, to, subject, text }) => ({ from, to, subject, text })),
    '/__mock/webhooks': () => hook.posts,
    '/__mock/mcp-calls': () => ({
      readWrite: mcp.calls.map(({ name, jiraUrl }) => ({ name, jiraUrl })),
      readOnly: mcpReadonly.calls.map(({ name, jiraUrl }) => ({ name, jiraUrl })),
    }),
  },
});
console.log(
  'mocks ready: jira http://127.0.0.1:4010, llm http://127.0.0.1:4020/v1, mcp-atlassian http://127.0.0.1:4050/mcp (read-only twin /readonly/mcp), smtp 127.0.0.1:4070, webhooks http://127.0.0.1:4080',
);
