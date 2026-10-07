import { describe, expect, it } from 'vitest';
import { systemPrompt } from './prompt';

describe('systemPrompt', () => {
  it('sends issue questions to query_board and keeps tool results out of Markdown', () => {
    const text = systemPrompt({
      now: new Date('2026-10-07T00:00:00Z'),
      jiraSites: [],
      jira: 'read_only',
    });
    expect(text).toContain('call query_board');
    expect(text).toContain('do not redraw that data as a Markdown table or a Mermaid chart');
    expect(text).toContain('for a query_board result use metric "query"');
  });
});
