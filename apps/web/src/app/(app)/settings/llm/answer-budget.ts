import { isMaxOutputTokens } from '@agile/llm/output-budget';

export type ParsedAnswerBudget = { ok: true; tokens: number | null } | { ok: false };

/**
 * "32000", "32 000", "32,000" or "32.000" (tokens) → a number within the accepted range; empty →
 * null (the default budget).
 */
export function parseAnswerBudget(raw: string): ParsedAnswerBudget {
  const text = raw.trim();
  if (text === '') return { ok: true, tokens: null };
  if (!/^\d{1,3}(?:[\s,. ]\d{3})*$|^\d+$/.test(text)) return { ok: false };
  const tokens = Number(text.replace(/\D/g, ''));
  return isMaxOutputTokens(tokens) ? { ok: true, tokens } : { ok: false };
}
