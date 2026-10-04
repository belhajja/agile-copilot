import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Minimal OpenAI-compatible chat endpoint that always calls the requested tool. */
export async function startMockOpenAI(opts: { validKey: string }) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
      return send(404, { error: { message: 'not found' } });
    }
    if (req.headers.authorization !== `Bearer ${opts.validKey}`) {
      return send(401, {
        error: { message: 'Incorrect API key provided', type: 'invalid_request_error' },
      });
    }
    req.resume();
    req.on('end', () =>
      send(200, {
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: 1_760_000_000,
        model: 'mock',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'report_status', arguments: '{"status":"ok"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    /** Every request that reached the server ("METHOD /path"). */
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
