import { describe, expect, it } from 'vitest';
import { usesPointEstimates } from './estimation';

describe('usesPointEstimates', () => {
  it('accepts number fields and rejects time tracking (seconds are not points)', () => {
    expect(usesPointEstimates('customfield_10016')).toBe(true);
    expect(usesPointEstimates(null)).toBe(false);
    for (const id of [
      'timeoriginalestimate',
      'timeestimate',
      'aggregatetimeoriginalestimate',
      'aggregatetimeestimate',
    ]) {
      expect(usesPointEstimates(id)).toBe(false);
    }
  });
});
