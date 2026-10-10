import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The OpenAI chat messages the mock receives (only the fields the scripts read). */
export interface MockChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null | { type: string; text?: string; image_url?: { url: string } }[];
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/** What the model "does" this turn: call tools (after some text, optionally), or answer with text. */
export type MockTurn =
  | { toolCalls: { name: string; args: unknown }[]; text?: string }
  | { text: string };

export type MockScript = (request: { messages: MockChatMessage[]; tools: string[] }) => MockTurn;

export interface MockOpenAIOptions {
  validKey: string;
  /** Decides each turn; default `agentDemoScript`. The probe's forced tool call is always honoured. */
  script?: MockScript;
  /**
   * Model ids served at `GET /v1/models`, for listModels tests. Omitted: that route 404s, like a
   * server with no such endpoint. An empty `validKey` ('') skips the auth check on this route only
   * (an unauthenticated local server, e.g. an OpenAI-compatible key-optional setup).
   */
  models?: string[];
  /**
   * Behave like MiniMax M2 behind a LiteLLM gateway: without streaming, its reasoning comes inline
   * as `<think>…</think>` at the start of the content, a `required` tool choice ends with
   * finish_reason "tool_calls" but no call, and a named tool choice gets the reasoning in front of
   * the arguments. Streamed, the reasoning arrives apart (`reasoning_content`).
   */
  thinking?: boolean;
}

const THINK = '<think>The user wants an answer; let me work it out.</think>';

const textOf = (m: MockChatMessage | undefined) =>
  typeof m?.content === 'string'
    ? m.content
    : (m?.content ?? []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('');

/** The images of a message (`image_url` parts with data URLs): their type and decoded size. */
function imagesOf(m: MockChatMessage | undefined): { mediaType: string; bytes: number }[] {
  if (!Array.isArray(m?.content)) return [];
  return m.content.flatMap((c) => {
    const data =
      c.type === 'image_url' ? /^data:([^;,]+);base64,(.*)$/s.exec(c.image_url?.url ?? '') : null;
    return data?.[1] && data[2] !== undefined
      ? [{ mediaType: data[1], bytes: Buffer.from(data[2], 'base64').length }]
      : [];
  });
}

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

/** Names of the standing preferences (`<skill … trigger="always">`) the request carries. */
function preferencesOf(messages: MockChatMessage[]): string[] {
  const names = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'user') continue;
    for (const match of textOf(m).matchAll(/<skill name="([a-z0-9-]+)" trigger="always">/g)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names];
}

/** The skill a background run or preview asks to run (`<skill name="…">` in the run request). */
const runSkillOf = (text: string) =>
  /Run this skill now/.test(text) ? (/<skill name="([a-z0-9-]+)">/.exec(text)?.[1] ?? null) : null;

/**
 * Deterministic stand-in for a tool-calling model, used by the agent tests and e2e:
 * - "velocity" → list_boards → get_metric(average_velocity) on "DEMO Scrum" → states the number;
 * - "comment on KEY-1: text" → jira_add_comment (needs approval) → reports approved or rejected;
 * - "pin … cycle time" → list_boards → pin_widget(cycle_time kpi) on "DEMO Scrum";
 * - "per assignee" → list_boards → query_board(open bugs per assignee) on "DEMO Scrum" → one sentence;
 * - "stand-up" (when load_skill is offered) → load_skill(daily-standup-brief) → a short brief;
 * - a skill run ("Run this skill now" + `<skill name>`) → list_boards → "Report for <name>…";
 *   when the skill's text names `jira_search` (and it is offered), a live read first
 *   (jira_search "filter = 101"); when it contains `<!channel>`, the report ends with it (the
 *   kind of text an injected report would carry, for the delivery escaping tests);
 * - a skill draft (propose_skill offered) → propose_skill with fields read from the request;
 * - a question with images → "I received 1 image (image/png, 1234 bytes)", what reached the model;
 * - anything else → a short text answer.
 * Text answers end with "(preferences: a, b)" when standing preferences were sent.
 */
const OPEN_BUGS_QUERY = {
  title: 'Open bugs per assignee',
  filter: { types: ['Bug'], statusCategory: ['todo', 'in_progress'] },
  groupBy: ['assignee'],
  display: 'bar',
};

export const agentDemoScript: MockScript = ({ messages, tools }) => {
  const prefs = preferencesOf(messages);
  const say = (text: string): MockTurn => ({
    text: prefs.length > 0 ? `${text} (preferences: ${prefs.join(', ')})` : text,
  });
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const ask = textOf(lastUser);
  const last = messages.at(-1);
  if (tools.includes('propose_skill')) {
    const weekly = /every monday/i.test(ask);
    return {
      toolCalls: [
        {
          name: 'propose_skill',
          args: {
            name: weekly ? 'monday-risks' : 'my-skill',
            description: weekly
              ? 'Stories at risk for the sprint goal, every Monday'
              : 'A custom analysis',
            trigger: weekly ? 'schedule' : 'on_demand',
            ...(weekly ? { cron: '0 8 * * 1', timezone: 'UTC' } : {}),
            output: weekly ? 'email' : 'chat',
            instructions:
              '1. Call list_boards.\n2. For each Scrum board, check the current sprint burndown and list the stories at risk.',
          },
        },
      ],
    };
  }
  const run = runSkillOf(ask);
  if (last?.role === 'tool') {
    const name = toolNameOf(messages, last.tool_call_id);
    const content = textOf(last);
    if (name === 'list_boards') {
      const boards = toolPayload(content) as { boards?: { id: string; name: string }[] };
      if (run) {
        const report = `Report for ${run}: ${boards?.boards?.length ?? 0} boards checked.`;
        return say(/<!channel>/.test(ask) ? `${report} <!channel>` : report);
      }
      const board = boards?.boards?.find((b) => b.name === 'DEMO Scrum') ?? boards?.boards?.[0];
      if (!board) return say('I could not find any synced board.');
      if (/per assignee/i.test(ask) && tools.includes('query_board')) {
        return {
          toolCalls: [{ name: 'query_board', args: { boardId: board.id, query: OPEN_BUGS_QUERY } }],
        };
      }
      if (/\bpin\b/i.test(ask) && tools.includes('pin_widget')) {
        return {
          toolCalls: [
            {
              name: 'pin_widget',
              args: { boardId: board.id, metric: 'cycle_time', chart: 'kpi', title: 'Cycle time' },
            },
          ],
        };
      }
      return {
        toolCalls: [
          { name: 'get_metric', args: { boardId: board.id, metric: 'average_velocity' } },
        ],
      };
    }
    if (name === 'get_metric') {
      const metric = toolPayload(content) as { data?: { value?: number } };
      return say(
        `The average velocity of DEMO Scrum is ${metric?.data?.value ?? 'unknown'} points per sprint.`,
      );
    }
    if (name === 'query_board') return say('Here are the open bugs per assignee.');
    if (name === 'jira_search' && run) return { toolCalls: [{ name: 'list_boards', args: {} }] };
    if (name === 'pin_widget') {
      return /"pinned":true/.test(content)
        ? say('Pinned: the cycle time is on your dashboard.')
        : say('I could not pin that chart.');
    }
    if (name === 'load_skill') {
      return /<skill name="daily-standup-brief">/.test(content)
        ? say('Stand-up brief: nothing is blocked today.')
        : say('I could not load that skill.');
    }
    if (name === 'jira_add_comment') {
      // "denied" mirrors the AI SDK's OpenAI-compatible adapter, which sends a denied approval
      // as the tool result "Tool call execution denied." (or the denial reason, when given).
      return /denied|rejected|not approved/i.test(content)
        ? say('Understood, I did not post the comment.')
        : say('Done: the comment is posted.');
    }
    return say('Here is what I found.');
  }
  if (run) {
    if (/jira_search/.test(ask) && tools.includes('jira_search')) {
      return { toolCalls: [{ name: 'jira_search', args: { jql: 'filter = 101', limit: 5 } }] };
    }
    return tools.includes('list_boards')
      ? { toolCalls: [{ name: 'list_boards', args: {} }] }
      : say(`Report for ${run}: no tools.`);
  }
  const images = last?.role === 'user' ? imagesOf(lastUser) : [];
  if (images.length > 0) {
    const n = images.length;
    const list = images.map((i) => `${i.mediaType}, ${i.bytes} bytes`).join('; ');
    return say(`I received ${n} image${n === 1 ? '' : 's'} (${list}).`);
  }
  if (
    (/velocity/i.test(ask) ||
      (/\bpin\b/i.test(ask) && tools.includes('pin_widget')) ||
      /per assignee/i.test(ask)) &&
    tools.includes('list_boards')
  ) {
    return { toolCalls: [{ name: 'list_boards', args: {} }] };
  }
  if (/stand-?up/i.test(ask) && tools.includes('load_skill')) {
    return { toolCalls: [{ name: 'load_skill', args: { name: 'daily-standup-brief' } }] };
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
  return say('I can answer questions about your boards and act in Jira with your approval.');
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
    /** Each offered tool's JSON Schema (`function.parameters`), by name. */
    toolSchemas: Record<string, unknown>;
    stream: boolean;
    /** The request's output budget (`max_tokens`), if any. */
    maxTokens?: number;
  }[] = [];
  let calls = 0;

  const server = createServer((req, res) => {
    const seen = { method: req.method ?? '', url: req.url ?? '' };
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      req.resume();
      if (opts.models === undefined) return send(res, 404, { error: { message: 'not found' } });
      if (opts.validKey && req.headers.authorization !== `Bearer ${opts.validKey}`) {
        return send(res, 401, {
          error: { message: 'Incorrect API key provided', type: 'invalid_request_error' },
        });
      }
      return send(res, 200, {
        data: opts.models.map((id) => ({ id, object: 'model' })),
      });
    }
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
      requests.push({ ...seen, messages: [], tools: [], toolSchemas: {}, stream: false });
      req.resume();
      return send(res, 404, { error: { message: 'not found' } });
    }
    if (req.headers.authorization !== `Bearer ${opts.validKey}`) {
      requests.push({ ...seen, messages: [], tools: [], toolSchemas: {}, stream: false });
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
        tools?: { function: { name: string; parameters?: unknown } }[];
        tool_choice?: unknown;
        stream?: boolean;
        stream_options?: { include_usage?: boolean };
        max_tokens?: number;
      };
      const tools = (body.tools ?? []).map((t) => t.function.name);
      const messages = body.messages ?? [];
      const toolSchemas = Object.fromEntries(
        (body.tools ?? []).map((t) => [t.function.name, t.function.parameters]),
      );
      requests.push({
        ...seen,
        messages,
        tools,
        toolSchemas,
        stream: body.stream === true,
        maxTokens: body.max_tokens,
      });
      const thinking = opts.thinking === true;
      const inline = thinking && !body.stream;
      const required = body.tool_choice === 'required';
      const named = typeof body.tool_choice === 'object' && body.tool_choice !== null;
      const forcedProbe = tools.includes('report_status') && (required || thinking);
      const turn: MockTurn =
        inline && required
          ? { toolCalls: [] }
          : forcedProbe
            ? { toolCalls: [{ name: 'report_status', args: { status: 'ok' } }] }
            : script({ messages, tools });
      const id = `chatcmpl-mock-${++calls}`;
      const usage = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };
      const toolCalls =
        'toolCalls' in turn
          ? turn.toolCalls.map((c, i) => ({
              id: `call_${calls}_${i}`,
              type: 'function' as const,
              function: {
                name: c.name,
                arguments: `${inline && named ? `${THINK}\n` : ''}${JSON.stringify(c.args)}`,
              },
            }))
          : undefined;
      const finish = 'toolCalls' in turn ? 'tool_calls' : 'stop';
      const text = 'text' in turn ? (turn.text ?? null) : null;

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
                content: inline ? `${THINK}\n\n${text ?? ''}` : text,
                ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
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
      if (thinking) chunk({ reasoning_content: THINK.replace(/<\/?think>/g, '') });
      // A few deltas, so clients really stream.
      if (text !== null)
        for (const piece of text.match(/.{1,16}/gs) ?? []) chunk({ content: piece });
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
