import { type ModelMessage, stepCountIs, streamText, tool } from 'ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLanguageModel } from './providers';
import { startMockOpenAI } from './testing/mock-openai-server';

// The scripted mock is what the agent tests and e2e talk to: it must stream text, stream tool
// calls (several steps), and report token usage like a real OpenAI-compatible server.
describe('scripted mock OpenAI server', () => {
  let mock: Awaited<ReturnType<typeof startMockOpenAI>>;
  beforeAll(async () => {
    mock = await startMockOpenAI({ validKey: 'good-key' });
  });
  afterAll(async () => mock?.close());
  const model = () =>
    createLanguageModel({
      provider: 'openai_compatible',
      model: 'mock',
      baseUrl: mock.baseUrl,
      apiKey: 'good-key',
    });
  const envelope = (source: string, value: unknown) =>
    `<data source="${source}">\n${JSON.stringify(value)}\n</data>`;

  it('streams a multi-step tool-calling answer with usage', async () => {
    const result = streamText({
      model: model(),
      tools: {
        list_boards: tool({
          inputSchema: z.object({}),
          execute: async () =>
            envelope('list_boards', { boards: [{ id: 'b-1', name: 'DEMO Scrum' }] }),
        }),
        get_metric: tool({
          inputSchema: z.object({ boardId: z.string(), metric: z.string() }),
          execute: async (input) => envelope('get_metric', { input, data: { value: 19 } }),
        }),
      },
      stopWhen: stepCountIs(5),
      prompt: 'What is our velocity?',
    });
    const deltas: string[] = [];
    for await (const d of result.textStream) deltas.push(d);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe('The average velocity of DEMO Scrum is 19 points per sprint.');
    const steps = await result.steps;
    expect(steps.map((s) => s.toolCalls.map((c) => c.toolName))).toEqual([
      ['list_boards'],
      ['get_metric'],
      [],
    ]);
    expect(steps[1]?.toolCalls[0]?.input).toEqual({ boardId: 'b-1', metric: 'average_velocity' });
    expect(await result.totalUsage).toMatchObject({ inputTokens: 360, outputTokens: 90 });
  });

  it('proposes a Jira comment and reacts to a denial', async () => {
    const first = streamText({
      model: model(),
      tools: {
        jira_add_comment: tool({
          inputSchema: z.object({ issueKey: z.string(), body: z.string() }),
          execute: async () => 'ok',
        }),
      },
      toolApproval: () => 'user-approval',
      prompt: 'Please comment on DEMO-1: Blocked by the API team',
    });
    const content = await first.content;
    const request = content.find((p) => p.type === 'tool-approval-request');
    expect(request?.toolCall).toMatchObject({
      toolName: 'jira_add_comment',
      input: { issueKey: 'DEMO-1', body: 'Blocked by the API team' },
    });
    if (request?.type !== 'tool-approval-request') throw new Error('no approval request');

    const messages: ModelMessage[] = [
      { role: 'user', content: 'Please comment on DEMO-1: Blocked by the API team' },
      ...(await first.response).messages,
      {
        role: 'tool',
        content: [
          { type: 'tool-approval-response', approvalId: request.approvalId, approved: false },
        ],
      },
    ];
    const second = streamText({
      model: model(),
      tools: {
        jira_add_comment: tool({
          inputSchema: z.object({ issueKey: z.string(), body: z.string() }),
          execute: async () => 'ok',
        }),
      },
      toolApproval: () => 'user-approval',
      messages,
    });
    expect(await second.text).toBe('Understood, I did not post the comment.');
  });

  it('streams two parallel tool calls in fragments', async () => {
    const calls: unknown[] = [];
    const m = await startMockOpenAI({
      validKey: 'k',
      script: ({ messages }) =>
        messages.at(-1)?.role === 'tool'
          ? { text: 'done' }
          : {
              toolCalls: [
                { name: 'a', args: { value: 'first call argument' } },
                { name: 'b', args: { value: 'second call argument' } },
              ],
            },
    });
    try {
      const result = streamText({
        model: createLanguageModel({
          provider: 'openai_compatible',
          model: 'mock',
          baseUrl: m.baseUrl,
          apiKey: 'k',
        }),
        tools: {
          a: tool({
            inputSchema: z.object({ value: z.string() }),
            execute: async (i) => calls.push(['a', i]),
          }),
          b: tool({
            inputSchema: z.object({ value: z.string() }),
            execute: async (i) => calls.push(['b', i]),
          }),
        },
        stopWhen: stepCountIs(3),
        prompt: 'go',
      });
      const argDeltas: string[] = [];
      for await (const part of result.fullStream) {
        if (part.type === 'tool-input-delta') argDeltas.push(part.delta);
      }
      expect(argDeltas.length).toBeGreaterThan(2);
      expect(calls).toEqual([
        ['a', { value: 'first call argument' }],
        ['b', { value: 'second call argument' }],
      ]);
    } finally {
      await m.close();
    }
  });

  it('receives images as image_url parts and says what reached it', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(92, 1),
    ]);
    const result = streamText({
      model: model(),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is on this chart?' },
            { type: 'file', mediaType: 'image/png', data: png },
          ],
        },
      ],
    });
    expect(await result.text).toBe('I received 1 image (image/png, 100 bytes).');
    const sent = mock.requests.at(-1)?.messages.at(-1)?.content;
    expect(sent).toEqual([
      { type: 'text', text: 'What is on this chart?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
    ]);
  });

  it('answers 500 with a JSON error when the script throws or the body is malformed', async () => {
    const m = await startMockOpenAI({
      validKey: 'k',
      script: () => {
        throw new Error('boom');
      },
    });
    try {
      const post = (body: string) =>
        fetch(`${m.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { authorization: 'Bearer k', 'content-type': 'application/json' },
          body,
        });
      const thrown = await post(JSON.stringify({ messages: [] }));
      expect(thrown.status).toBe(500);
      expect(await thrown.json()).toMatchObject({
        error: { message: expect.stringContaining('boom') },
      });
      const malformed = await post('{not json');
      expect(malformed.status).toBe(500);
      expect(await malformed.json()).toHaveProperty('error.message');
    } finally {
      await m.close();
    }
  });
});
