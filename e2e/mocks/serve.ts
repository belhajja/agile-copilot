import { createServer, request } from 'node:http';
import { demoDataset, startMockJira } from '@agile/jira/testing';
import { startMockOpenAI } from '@agile/llm/testing';

// The mocks listen on random ports; expose them on fixed ports via a tiny reverse proxy.
async function expose(port: number, target: string) {
  const t = new URL(target);
  const server = createServer((req, res) => {
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
const llm = await startMockOpenAI({ validKey: 'good-key' });
await expose(4010, jira.url);
await expose(4020, new URL(llm.baseUrl).origin);
console.log('mocks ready: jira http://127.0.0.1:4010, llm http://127.0.0.1:4020/v1');
