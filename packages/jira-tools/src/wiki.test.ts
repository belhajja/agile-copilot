import { describe, expect, it } from 'vitest';
import { WIKI_CASES } from './testing/wiki-cases';
import { markdownToJiraWiki } from './wiki';

describe('markdownToJiraWiki (mcp-atlassian 0.23.1 compatible)', () => {
  it.each(WIKI_CASES)('%j', (markdown, wiki) => {
    expect(markdownToJiraWiki(markdown)).toBe(wiki);
  });
});
