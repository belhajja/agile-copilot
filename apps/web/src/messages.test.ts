import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import fr from '../messages/fr.json';

/** Every key path of a messages object, e.g. `delivery.errors.blocked.scheme`. */
const keys = (value: unknown, prefix = ''): string[] =>
  value && typeof value === 'object'
    ? Object.entries(value).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k))
    : [prefix];

describe('messages', () => {
  it('has the same keys in English and French', () => {
    expect(keys(fr).sort()).toEqual(keys(en).sort());
  });

  it('uses the same placeholders in both languages', () => {
    // ICU arguments ({name} or {count, plural, …}), not the text of plural branches ("one {sprint}").
    const placeholders = (text: string) =>
      [...text.matchAll(/(?<!(?:zero|one|two|few|many|other|=\d+)\s?)\{(\w+)/g)]
        .map((m) => m[1])
        .sort();
    const at = (root: unknown, path: string) =>
      path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], root);
    const mismatched = keys(en).filter(
      (path) =>
        JSON.stringify(placeholders(String(at(en, path)))) !==
        JSON.stringify(placeholders(String(at(fr, path)))),
    );
    expect(mismatched).toEqual([]);
  });
});
