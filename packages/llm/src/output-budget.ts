// Dependency-free so client components can import it via '@agile/llm/output-budget'.

/**
 * A model's answer budget: output tokens per model call, reasoning included. A connection without
 * its own value uses the default.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
export const MIN_MAX_OUTPUT_TOKENS = 1_000;
export const MAX_MAX_OUTPUT_TOKENS = 64_000;

export const isMaxOutputTokens = (v: number) =>
  Number.isInteger(v) && v >= MIN_MAX_OUTPUT_TOKENS && v <= MAX_MAX_OUTPUT_TOKENS;
