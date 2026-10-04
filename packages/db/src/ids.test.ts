import { describe, expect, it } from 'vitest';
import { isUuid } from './ids';

describe('isUuid', () => {
  it('accepts uuids only', () => {
    expect(isUuid('5b7c9b64-d4eb-4210-8ab7-4be8bf3e6aee')).toBe(true);
    expect(isUuid('5B7C9B64-D4EB-4210-8AB7-4BE8BF3E6AEE')).toBe(true);
    for (const v of ['', 'x', '5b7c9b64-d4eb-4210-8ab7-4be8bf3e6aee ', 42, null, undefined]) {
      expect(isUuid(v)).toBe(false);
    }
  });
});
