import type { LanguageModel } from 'ai';
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
});
