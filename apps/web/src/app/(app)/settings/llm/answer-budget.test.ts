import { describe, expect, it } from 'vitest';
import { parseAnswerBudget } from './answer-budget';

describe('parseAnswerBudget', () => {
  it('reads plain and grouped numbers', () => {
    for (const raw of ['32000', ' 32000 ', '32 000', '32,000', '32.000', '32 000']) {
      expect(parseAnswerBudget(raw)).toEqual({ ok: true, tokens: 32_000 });
    }
  });

  it('reads an empty field as the default', () => {
    expect(parseAnswerBudget('')).toEqual({ ok: true, tokens: null });
    expect(parseAnswerBudget('   ')).toEqual({ ok: true, tokens: null });
  });

  it('accepts the bounds and refuses anything outside 1 000–64 000', () => {
    expect(parseAnswerBudget('1000')).toEqual({ ok: true, tokens: 1_000 });
    expect(parseAnswerBudget('64000')).toEqual({ ok: true, tokens: 64_000 });
    for (const raw of ['999', '64001', '100000', '0']) {
      expect(parseAnswerBudget(raw)).toEqual({ ok: false });
    }
  });

  it('refuses decimals, signs and text', () => {
    for (const raw of ['16.5', '1.5', '-2000', '16k', 'abc', '3 00', '1e4']) {
      expect(parseAnswerBudget(raw)).toEqual({ ok: false });
    }
  });
});
