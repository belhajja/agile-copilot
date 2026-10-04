import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The OpenAI chat messages the mock receives (only the fields the scripts read). */
export interface MockChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null | { type: string; text?: string }[];
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/** What the model "does" this turn: call tools, or answer with text. */
export type MockTurn = { toolCalls: { name: string; args: unknown }[] } | { text: string };

export type MockScript = (request: { messages: MockChatMessage[]; tools: string[] }) => MockTurn;

export interface MockOpenAIOptions {
  validKey: string;
  /** Decides each turn; default `agentDemoScript`. The probe's forced tool call is always honoured. */
  script?: MockScript;
}

const textOf = (m: MockChatMessage | undefined) =>
  typeof m?.content === 'string'
    ? m.content
    : (m?.content ?? []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('');

/** The tool call a tool message answers, found in the assistant message before it. */
function toolNameOf(messages: MockChatMessage[], toolCallId: string | undefined) {
  // From the end: ids restart after a mock restart, the latest call wins.
  for (const m of [...messages].reverse()) {
    const call = m.tool_calls?.find((c) => c.id === toolCallId);
    if (call) return call.function.name;
  }
  return undefined;
}

const parse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/** The JSON inside the agent's `<data source="…">…</data>` tool-result envelope. */
function toolPayload(content: string): unknown {
  const wrapped = /^<data source="[^"]*">\n([\s\S]*)\n<\/data>$/.exec(content.trim());
  return parse(wrapped?.[1] ?? content);
}

/**
 * Deterministic stand-in for a tool-calling model, used by the agent tests and e2e:
 * - "velocity" → list_boards → get_metric(average_velocity) on "DEMO Scrum" → states the number;
 * - "comment on KEY-1: text" → jira_add_comment (needs approval) → reports approved or rejected;
 * - anything else → a short text answer.
 */
export const agentDemoScript: MockScript = ({ messages, tools }) => {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const ask = textOf(lastUser);
  const last = messages.at(-1);
  if (last?.role === 'tool') {
    const name = toolNameOf(messages, last.tool_call_id);
    const content = textOf(last);
    if (name === 'list_boards') {
      const boards = toolPayload(content) as { boards?: { id: string; name: string }[] };
      const board = boards?.boards?.find((b) => b.name === 'DEMO Scrum') ?? boards?.boards?.[0];
      if (!board) return { text: 'I could not find any synced board.' };
      return {
        toolCalls: [
          { name: 'get_metric', args: { boardId: board.id, metric: 'average_velocity' } },
        ],
      };
    }
    if (name === 'get_metric') {
      const metric = toolPayload(content) as { data?: { value?: number } };
      return {
        text: `The average velocity of DEMO Scrum is ${metric?.data?.value ?? 'unknown'} points per sprint.`,
      };
    }
    if (name === 'jira_add_comment') {
      // "denied" mirrors the AI SDK's OpenAI-compatible adapter, which sends a denied approval
      // as the tool result "Tool call execution denied." (or the denial reason, when given).
      return /denied|rejected|not approved/i.test(content)
        ? { text: 'Understood, I did not post the comment.' }
        : { text: 'Done: the comment is posted.' };
    }
    return { text: 'Here is what I found.' };
  }
  if (/velocity/i.test(ask) && tools.includes('list_boards')) {
    return { toolCalls: [{ name: 'list_boards', args: {} }] };
  }
  const comment = /comment on ([A-Z][A-Z0-9]+-\d+)\s*:\s*(.+)$/is.exec(ask);
  if (comment && tools.includes('jira_add_comment')) {
    return {
      toolCalls: [
        {
          name: 'jira_add_comment',
          args: { issueKey: comment[1], body: comment[2]?.trim() ?? '' },
        },
      ],
    };
  }
  return { text: 'I can answer questions about your boards and act in Jira with your approval.' };
};

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/**
 * Minimal OpenAI-compatible chat endpoint. Non-streaming requests that force `report_status` get
 * the probe answer; everything else follows the script, streamed (SSE) when asked, with usage.
 */
export async function startMockOpenAI(opts: MockOpenAIOptions) {
  const script = opts.script ?? agentDemoScript;
  /** Every request that reached the server, including rejected ones (those have no messages). */
  const requests: {
    method: string;
    url: string;
    messages: MockChatMessage[];
    tools: string[];
    stream: boolean;
  }[] = [];
  let calls = 0;

  const server = createServer((req, res) => {
    const seen = { method: req.method ?? '', url: req.url ?? '' };
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
      requests.push({ ...seen, messages: [], tools: [], stream: false });
      req.resume();
      return send(res, 404, { error: { message: 'not found' } });
    }
    if (req.headers.authorization !== `Bearer ${opts.validKey}`) {
      requests.push({ ...seen, messages: [], tools: [], stream: false });
      req.resume();
      return send(res, 401, {
        error: { message: 'Incorrect API key provided', type: 'invalid_request_error' },
      });
    }
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      try {
        handle(raw);
      } catch (error) {
        if (res.headersSent) return res.destroy();
        send(res, 500, {
          error: {
            message: `mock server error: ${error instanceof Error ? error.message : 'unknown'}`,
          },
        });
      }
    });
    const handle = (raw: string) => {
      const body = JSON.parse(raw) as {
        messages?: MockChatMessage[];
        tools?: { function: { name: string } }[];
        tool_choice?: unknown;
        stream?: boolean;
        stream_options?: { include_usage?: boolean };
      };
      const tools = (body.tools ?? []).map((t) => t.function.name);
      const messages = body.messages ?? [];
      requests.push({ ...seen, messages, tools, stream: body.stream === true });
      const forcedProbe = tools.includes('report_status') && body.tool_choice === 'required';
      const turn: MockTurn = forcedProbe
        ? { toolCalls: [{ name: 'report_status', args: { status: 'ok' } }] }
        : script({ messages, tools });
      const id = `chatcmpl-mock-${++calls}`;
      const usage = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };
      const toolCalls =
        'toolCalls' in turn
          ? turn.toolCalls.map((c, i) => ({
              id: `call_${calls}_${i}`,
              type: 'function' as const,
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            }))
          : undefined;
      const finish = toolCalls ? 'tool_calls' : 'stop';

      if (!body.stream) {
        return send(res, 200, {
          id,
          object: 'chat.completion',
          created: 1_760_000_000,
          model: 'mock',
          choices: [
            {
              index: 0,
              finish_reason: finish,
              message: {
                role: 'assistant',
                content: 'text' in turn ? turn.text : null,
                ...(toolCalls ? { tool_calls: toolCalls } : {}),
              },
            },
          ],
          usage,
        });
      }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const chunk = (delta: unknown, finishReason: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created: 1_760_000_000,
            model: 'mock',
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`,
        );
      chunk({ role: 'assistant', content: '' });
      if (toolCalls) {
        // Like real servers: id + name + the start of the arguments first, then the rest in pieces.
        toolCalls.forEach((c, index) => {
          const args = c.function.arguments;
          const cut = Math.max(1, Math.floor(args.length / 3));
          chunk({
            tool_calls: [
              {
                index,
                id: c.id,
                type: c.type,
                function: { name: c.function.name, arguments: args.slice(0, cut) },
              },
            ],
          });
          const rest = args.slice(cut);
          const size = Math.max(1, Math.ceil(rest.length / 3));
          for (let at = 0; at < rest.length; at += size) {
            chunk({ tool_calls: [{ index, function: { arguments: rest.slice(at, at + size) } }] });
          }
        });
      } else if ('text' in turn) {
        // A few deltas, so clients really stream.
        for (const piece of turn.text.match(/.{1,16}/gs) ?? []) chunk({ content: piece });
      }
      chunk({}, finish);
      if (body.stream_options?.include_usage) {
        res.write(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1_760_000_000, model: 'mock', choices: [], usage })}\n\n`,
        );
      }
      res.end('data: [DONE]\n\n');
    };
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
