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

  it('runs in linear time: 10k pathological characters convert in under 50 ms each', () => {
    markdownToJiraWiki(generatedMarkdown(50).join('')); // warm up the JIT
    const slow: Record<string, number> = {};
    for (const [name, input] of Object.entries(pathologicalMarkdown(10_000))) {
      const start = performance.now();
      markdownToJiraWiki(input);
      const ms = performance.now() - start;
      if (ms >= 50) slow[name] = Math.round(ms);
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
