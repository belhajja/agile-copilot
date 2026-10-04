import type { LlmConfig } from '@agile/llm';
import { createLanguageModel } from '@agile/llm';
import { createOutboundFetch } from '@agile/net';
import type { LanguageModel } from 'ai';
import type { AgentDeps } from './deps';

/**
 * The language model for a chat reply, a skill run or a draft: the injected factory (tests) or
 * `createLanguageModel`, whose user-supplied URL (OpenAI-compatible) is resolved once and pinned
 * (DNS rebinding).
 */
export function languageModelFor(deps: AgentDeps, config: LlmConfig): LanguageModel {
  if (deps.createModel) return deps.createModel(config);
  return createLanguageModel(config, {
    fetch: createOutboundFetch({
      allowedPrivateHosts: deps.allowedPrivateHosts,
      resolve: deps.resolve,
    }),
  });
}
