/** Largest accepted price: 1,000 currency units per million tokens (same cap as @agile/connections). */
export const MAX_PRICE_MICROS = 1_000_000_000;

export type ParsedPrice = { ok: true; micros: number | null } | { ok: false };

/**
 * "3", "0.15" or "0,15" (price per million tokens) → millionths of a currency unit; empty → null.
 * Pure integer arithmetic (no float rounding); at most 6 decimals, between 0 and the cap.
 */
export function parsePrice(raw: string): ParsedPrice {
  const text = raw.trim().replace(',', '.');
  if (text === '') return { ok: true, micros: null };
  const m = /^(\d{1,10})(?:\.(\d{1,6}))?$/.exec(text);
  if (!m) return { ok: false };
  const micros = Number(m[1]) * 1_000_000 + Number((m[2] ?? '').padEnd(6, '0'));
  return micros <= MAX_PRICE_MICROS ? { ok: true, micros } : { ok: false };
}
