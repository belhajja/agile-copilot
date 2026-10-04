import { type LanguageModel, streamText } from 'ai';
import { describe, expect, it } from 'vitest';
import { createLanguageModel, type LlmConfig } from './providers';

const info = (m: LanguageModel) => m as unknown as { provider: string; modelId: string };

describe('createLanguageModel', () => {
  it.each<[LlmConfig, RegExp]>([
    [{ provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'k' }, /anthropic/],
    [{ provider: 'openai', model: 'some-model', apiKey: 'k' }, /openai/],
    [{ provider: 'google', model: 'some-model', apiKey: 'k' }, /google/],
    [{ provider: 'mistral', model: 'some-model', apiKey: 'k' }, /mistral/],
    [{ provider: 'azure', model: 'my-deployment', apiKey: 'k', resourceName: 'res' }, /azure/],
    [
      { provider: 'openai_compatible', model: 'llama3.1', baseUrl: 'http://ollama:11434/v1' },
      /openai_compatible/,
    ],
  ])('builds %o', (cfg, provider) => {
    const m = info(createLanguageModel(cfg));
    expect(m.provider).toMatch(provider);
    expect(m.modelId).toBe(cfg.model);
  });

  it('rejects Azure resource names that could redirect the host', () => {
    expect(() =>
      createLanguageModel({
        provider: 'azure',
        model: 'd',
        apiKey: 'k',
        resourceName: 'evil.com/#',
      }),
    ).toThrow(TypeError);
    expect(() =>
      createLanguageModel({
        provider: 'azure',
        model: 'd',
        apiKey: 'k',
        resourceName: 'my-resource',
      }),
    ).not.toThrow();
  });

  it('asks an OpenAI-compatible server for token usage in streamed answers', async () => {
    const bodies: unknown[] = [];
    const capture = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status: 500 });
    }) as typeof fetch;
    const model = createLanguageModel(
      { provider: 'openai_compatible', model: 'm', baseUrl: 'http://llm.test/v1' },
      { fetch: capture },
    );
    const result = streamText({ model, prompt: 'hi', maxRetries: 0, onError: () => {} });
    await result.consumeStream({ onError: () => {} });
    expect(bodies[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });
});
