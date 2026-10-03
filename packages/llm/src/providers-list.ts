// Dependency-free so client components can import it via '@agile/llm/providers-list'
// without pulling the provider SDKs into the browser bundle.
export const LLM_PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'azure',
  'mistral',
  'openai_compatible',
] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];
