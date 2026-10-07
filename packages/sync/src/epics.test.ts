import { describe, expect, it } from 'vitest';
import { epicNames } from './epics';

function source(byKey: Record<string, string>, failOn?: string) {
  const calls: string[] = [];
  return {
    calls,
    async *searchIssues(jql: string) {
      calls.push(jql);
      const keys = /key in \(([^)]*)\)/.exec(jql)?.[1]?.split(',') ?? [];
      if (failOn && keys.includes(failOn)) throw new Error('400 from Jira');
      yield keys.flatMap((key) =>
        byKey[key] ? [{ id: key, key, fields: { summary: byKey[key] } }] : [],
      );
    },
  };
}

describe('epicNames', () => {
  it('looks epics up by key, 50 per search, skipping malformed keys', async () => {
    const keys = Array.from({ length: 60 }, (_, i) => `EP-${i + 1}`);
    const s = source({ 'EP-1': 'Checkout', 'EP-60': 'Platform' });
    const names = await epicNames(s as never, [...keys, 'EP-1', 'bad key) or 1=1']);
    expect(names).toEqual(
      new Map([
        ['EP-1', 'Checkout'],
        ['EP-60', 'Platform'],
      ]),
    );
    expect(s.calls).toHaveLength(2);
    expect(s.calls[0]).toBe(`key in (${keys.slice(0, 50).join(',')})`);
  });

  it('keeps going when one search fails (names are cosmetic)', async () => {
    const keys = Array.from({ length: 51 }, (_, i) => `EP-${i + 1}`);
    const names = await epicNames(source({ 'EP-51': 'Late' }, 'EP-1') as never, keys);
    expect(names).toEqual(new Map([['EP-51', 'Late']]));
  });

  it('splits a failing search to keep the names of the other keys in it', async () => {
    const keys = Array.from({ length: 50 }, (_, i) => `EP-${i + 1}`);
    const s = source({ 'EP-1': 'Checkout', 'EP-30': 'Platform', 'EP-50': 'Billing' }, 'EP-7');
    const names = await epicNames(s as never, keys);
    expect(names).toEqual(
      new Map([
        ['EP-1', 'Checkout'],
        ['EP-30', 'Platform'],
        ['EP-50', 'Billing'],
      ]),
    );
    expect(s.calls).toContain('key in (EP-7)');
    expect(s.calls.length).toBeLessThanOrEqual(1 + 2 * Math.ceil(Math.log2(50)));
  });
});
