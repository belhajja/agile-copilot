import { describe, expect, it } from 'vitest';
import { decisionReasonOf, REASON_TEXT } from './reasons';

describe('decisionReasonOf', () => {
  it('maps every stored sentence back to its code', () => {
    expect(decisionReasonOf(REASON_TEXT.superseded)).toBe('superseded');
    expect(decisionReasonOf(REASON_TEXT.forbidden_role)).toBe('forbidden_role');
  });

  it('is undefined for any other text', () => {
    expect(decisionReasonOf('superseded')).toBeUndefined();
    expect(decisionReasonOf('The user said no.')).toBeUndefined();
    expect(decisionReasonOf(undefined)).toBeUndefined();
  });
});
