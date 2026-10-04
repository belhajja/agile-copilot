import { fetchNoRedirect } from '@agile/net';
import { type LanguageModel, streamText } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { createLanguageModel, type LlmConfig } from './providers';

// The options each fixed-vendor provider factory was built with (the real factories still run).
const { built, spy } = vi.hoisted(() => {
  const built = new Map<string, { fetch?: unknown }>();
  type Factory = (o: { fetch?: unknown }) => unknown;
  const spy = (name: string, factory: string) => async (importOriginal: () => Promise<unknown>) => {
    const mod = (await importOriginal()) as Record<string, Factory>;
    const real = mod[factory] as Factory;
    return {
      ...mod,
      [factory]: (o: { fetch?: unknown }) => {
        built.set(name, o);
        return real(o);
      },
    };
  };
  return { built, spy };
});
vi.mock('@ai-sdk/anthropic', spy('anthropic', 'createAnthropic'));
vi.mock('@ai-sdk/openai', spy('openai', 'createOpenAI'));
vi.mock('@ai-sdk/google', spy('google', 'createGoogleGenerativeAI'));
vi.mock('@ai-sdk/mistral', spy('mistral', 'createMistral'));
vi.mock('@ai-sdk/azure', spy('azure', 'createAzure'));

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

  it('never follows redirects from the fixed vendor hosts either', () => {
    built.clear();
    const configs: LlmConfig[] = [
      { provider: 'anthropic', model: 'm', apiKey: 'k' },
      { provider: 'openai', model: 'm', apiKey: 'k' },
      { provider: 'google', model: 'm', apiKey: 'k' },
      { provider: 'mistral', model: 'm', apiKey: 'k' },
      { provider: 'azure', model: 'm', apiKey: 'k', resourceName: 'res' },
    ];
    for (const cfg of configs) createLanguageModel(cfg);
    expect([...built.keys()].sort()).toEqual(['anthropic', 'azure', 'google', 'mistral', 'openai']);
    for (const [, options] of built) expect(options.fetch).toBe(fetchNoRedirect);
  });
});
