import { generateText, streamText, tool } from 'ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLanguageModel } from './providers';
import { startMockOpenAI } from './testing/mock-openai-server';

// MiniMax M2 behind a LiteLLM gateway: reasoning inline as <think>…</think> without streaming.
describe('OpenAI-compatible reasoning models', () => {
  let mock: Awaited<ReturnType<typeof startMockOpenAI>>;
  const model = () =>
    createLanguageModel({
      provider: 'openai_compatible',
      model: 'minimax-m2.5',
      baseUrl: mock.baseUrl,
      apiKey: 'k',
    });

  beforeAll(async () => {
    mock = await startMockOpenAI({
      validKey: 'k',
      thinking: true,
      script: ({ tools }) =>
        tools.includes('propose_skill')
          ? { toolCalls: [{ name: 'propose_skill', args: { name: 'weekly-risks' } }] }
          : { text: 'The average velocity is 42 points.' },
    });
  });
  afterAll(() => mock.close());

  it('keeps the reasoning out of a generated answer', async () => {
    const result = await generateText({ model: model(), prompt: 'velocity?', maxRetries: 0 });
    expect(result.text.trim()).toBe('The average velocity is 42 points.');
    expect(result.reasoningText).toMatch(/let me work it out/);
  });

  it('keeps the reasoning out of a streamed answer', async () => {
    const result = streamText({ model: model(), prompt: 'velocity?', maxRetries: 0 });
    expect((await result.text).trim()).toBe('The average velocity is 42 points.');
  });

  it('parses the arguments of a forced tool call that starts with the reasoning', async () => {
    const result = await generateText({
      model: model(),
      prompt: 'a skill for weekly risks',
      tools: { propose_skill: tool({ inputSchema: z.object({ name: z.string() }) }) },
      toolChoice: { type: 'tool', toolName: 'propose_skill' },
      maxRetries: 0,
    });
    expect(result.toolCalls[0]?.input).toEqual({ name: 'weekly-risks' });
  });
});
