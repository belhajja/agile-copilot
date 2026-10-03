import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

export const LLM_PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'azure',
  'mistral',
  'openai_compatible',
] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export type LlmConfig =
  | { provider: 'anthropic' | 'openai' | 'google' | 'mistral'; model: string; apiKey: string }
  | { provider: 'azure'; model: string; apiKey: string; resourceName: string }
  | { provider: 'openai_compatible'; model: string; baseUrl: string; apiKey?: string };

/** Builds a model from a tenant's own key at call time (keys are never read from process.env). */
export function createLanguageModel(cfg: LlmConfig): LanguageModel {
  switch (cfg.provider) {
    case 'anthropic':
      return createAnthropic({ apiKey: cfg.apiKey })(cfg.model);
    case 'openai':
      return createOpenAI({ apiKey: cfg.apiKey })(cfg.model);
    case 'google':
      return createGoogleGenerativeAI({ apiKey: cfg.apiKey })(cfg.model);
    case 'mistral':
      return createMistral({ apiKey: cfg.apiKey })(cfg.model);
    case 'azure':
      return createAzure({ apiKey: cfg.apiKey, resourceName: cfg.resourceName })(cfg.model);
    case 'openai_compatible':
      return createOpenAICompatible({
        name: 'openai_compatible',
        baseURL: cfg.baseUrl,
        apiKey: cfg.apiKey || 'not-needed',
      })(cfg.model);
  }
}
