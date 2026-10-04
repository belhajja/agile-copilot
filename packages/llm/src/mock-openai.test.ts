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
});
