import { fetchNoRedirect } from '@agile/net';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { LLM_PROVIDERS, type LlmProvider } from './providers-list';

export { LLM_PROVIDERS, type LlmProvider };

export type LlmConfig =
  | { provider: 'anthropic' | 'openai' | 'google' | 'mistral'; model: string; apiKey: string }
  | { provider: 'azure'; model: string; apiKey: string; resourceName: string }
  | { provider: 'openai_compatible'; model: string; baseUrl: string; apiKey?: string };

const AZURE_RESOURCE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** Builds a model from a tenant's own key at call time (keys are never read from process.env). */
export function createLanguageModel(
  cfg: LlmConfig,
  opts: {
    /** Fetch for the user-supplied OpenAI-compatible URL (pass createOutboundFetch to pin DNS). */
    fetch?: typeof fetch;
  } = {},
): LanguageModel {
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
      if (!AZURE_RESOURCE_NAME.test(cfg.resourceName))
        throw new TypeError('Invalid Azure resource name');
      return createAzure({ apiKey: cfg.apiKey, resourceName: cfg.resourceName })(cfg.model);
    case 'openai_compatible':
      return createOpenAICompatible({
        name: 'openai_compatible',
        baseURL: cfg.baseUrl,
        apiKey: cfg.apiKey || 'not-needed',
        // Ask for token usage in streamed answers (the agent's cost meter needs it).
        includeUsage: true,
        // A user-supplied URL must not bounce us to internal hosts.
        fetch: opts.fetch ?? fetchNoRedirect,
      })(cfg.model);
  }
}
