import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The (app) layout only needs a session (the Account page works without a workspace, M3), so the
 * workspace check lives in each page, action and route handler. This test reads the sources and
 * fails when one of them lacks its guard. Exceptions are explicit and need a session instead.
 */
const APP = join(import.meta.dirname);
const AUTH = join(import.meta.dirname, '../(auth)');

/** Session-only files (a person without a workspace may use them), relative to (app). */
const SESSION_ONLY = new Set(['settings/account/page.tsx', 'settings/account/actions.ts']);

const filesUnder = (dir: string, name: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.split(/[\\/]/).pop() === name)
    .map((f) => join(dir, f))
    .sort();

const rel = (file: string) => relative(APP, file).split('\\').join('/');

/** Each exported async function of a module, with its body (up to the next top-level export). */
function exportedFunctions(source: string): { name: string; body: string }[] {
  return [...source.matchAll(/^export async function (\w+)/gm)].map((m) => {
    const from = (m.index ?? 0) + m[0].length;
    const next = source.slice(from).search(/^export /m);
    return { name: m[1] ?? '', body: source.slice(from, next >= 0 ? from + next : undefined) };
  });
}

const PAGE_GUARD = /await requireActor\(\)/;
const SESSION_GUARD = /await requireSignedIn\(/;
const ACTION_GUARD = /await (requireActor|requireSignedIn)\(/;
const ROUTE_GUARD = /await (currentActor|currentSession)\(/;

describe('(app) guards', () => {
  it('finds the pages, actions and the session-only exceptions it checks', () => {
    const pages = filesUnder(APP, 'page.tsx').map(rel);
    expect(pages.length).toBeGreaterThan(10);
    for (const f of SESSION_ONLY) {
      expect(pages.concat(filesUnder(APP, 'actions.ts').map(rel))).toContain(f);
    }
  });

  it('every page checks the workspace member (requireActor), except the session-only ones', () => {
    const missing = filesUnder(APP, 'page.tsx').filter((file) => {
      const source = readFileSync(file, 'utf8');
      return !(SESSION_ONLY.has(rel(file)) ? SESSION_GUARD : PAGE_GUARD).test(source);
    });
    expect(missing.map(rel)).toEqual([]);
  });

  it('every exported server action checks the caller first', () => {
    const missing: string[] = [];
    for (const file of [...filesUnder(APP, 'actions.ts'), ...filesUnder(AUTH, 'actions.ts')]) {
      const source = readFileSync(file, 'utf8');
      const guard = SESSION_ONLY.has(rel(file)) ? SESSION_GUARD : ACTION_GUARD;
      for (const fn of exportedFunctions(source)) {
        if (!guard.test(fn.body)) missing.push(`${rel(file)}#${fn.name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every route handler under (app) reads the caller from the request', () => {
    const missing = filesUnder(APP, 'route.ts').filter(
      (file) => !ROUTE_GUARD.test(readFileSync(file, 'utf8')),
    );
    expect(missing.map(rel)).toEqual([]);
  });

  it('notices a missing guard', () => {
    const [guarded, unguarded] = exportedFunctions(
      [
        'export async function a() {\n  const actor = await requireActor();\n}',
        'export async function b() {\n  return services();\n}',
      ].join('\n'),
    );
    expect(ACTION_GUARD.test(guarded?.body ?? '')).toBe(true);
    expect(ACTION_GUARD.test(unguarded?.body ?? '')).toBe(false);
    expect(PAGE_GUARD.test('export default async function P() { return null; }')).toBe(false);
  });
});
