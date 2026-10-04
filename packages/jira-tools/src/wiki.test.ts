import { describe, expect, it } from 'vitest';
import { generatedMarkdown, pathologicalMarkdown, WIKI_CASES } from './testing/wiki-cases';
import { markdownToJiraWiki } from './wiki';

describe('markdownToJiraWiki (mcp-atlassian 0.23.1 compatible)', () => {
  it.each(WIKI_CASES)('%j', (markdown, wiki) => {
    expect(markdownToJiraWiki(markdown)).toBe(wiki);
  });

  it('cannot be made to restore a placeholder the input forged (NUL is dropped)', () => {
    // mcp-atlassian keeps NUL and would put the code block in place of the forged placeholder.
    expect(markdownToJiraWiki('x\u0000CODEBLOCK0\u0000y ```\nz\n```')).toBe(
      'xCODEBLOCK0y {code}z\n{code}',
    );
  });

  it('runs in linear time: 40k pathological characters convert in well under a second each', () => {
    // A quadratic pattern took ~0.6 s at 10k characters, so ~10 s at 40k; linear code takes a few
    // ms. The bound sits far from both, so a loaded machine cannot fail it and a regression cannot
    // pass it. The best of three runs filters out a GC pause or a descheduled worker.
    markdownToJiraWiki(generatedMarkdown(50).join('')); // warm up the JIT
    const slow: Record<string, number> = {};
    for (const [name, input] of Object.entries(pathologicalMarkdown(40_000))) {
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        markdownToJiraWiki(input);
        best = Math.min(best, performance.now() - start);
      }
      if (best >= 1_000) slow[name] = Math.round(best);
    }
    expect(slow).toEqual({});
  });

  it('generates the same deterministic corpus every time', () => {
    const corpus = generatedMarkdown(300);
    expect(corpus).toHaveLength(300);
    expect(generatedMarkdown(300)).toEqual(corpus);
    expect(corpus.some((s) => s.includes('\u0000'))).toBe(false);
  });
});
