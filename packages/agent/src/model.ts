import type { LlmConfig } from '@agile/llm';
import { createLanguageModel } from '@agile/llm';
import { checkOutboundUrl, createOutboundFetch } from '@agile/net';
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

/**
 * An OpenAI-compatible URL stored before plain http to public hosts was refused: its API key must
 * not be sent. Anything else the URL policy refuses is left to the pinned fetch to report.
 */
export async function usesInsecureTransport(deps: AgentDeps, config: LlmConfig): Promise<boolean> {
  if (config.provider !== 'openai_compatible') return false;
  const check = await checkOutboundUrl(config.baseUrl, deps);
  return !check.ok && check.code === 'insecure_transport';
}
