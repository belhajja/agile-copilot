import { asUntrustedData } from '@agile/agent/untrusted';
import type { ToolUIPart } from 'ai';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

const { ToolCall } = await import('./tool-call');

const suggestion = {
  name: 'weekly-velocity',
  description: 'Velocity every Monday',
  trigger: 'schedule',
  output: 'email',
  document: '---\nname: weekly-velocity\n---\n\nSteps\n',
};

const part = {
  type: 'tool-suggest_skill',
  toolCallId: 't1',
  state: 'output-available',
  input: {},
  output: asUntrustedData('skill_suggestion', suggestion),
} as unknown as ToolUIPart;

const html = (busy: boolean) =>
  renderToString(
    createElement(ToolCall, { part, toolName: 'suggest_skill', conversationId: 'c1', busy }),
  );

describe('ToolCall (skill suggestion card)', () => {
  it('keeps the builder link off while the reply is still streaming', () => {
    const out = html(true);
    expect(out).not.toMatch(/<a\s/);
    expect(out).toMatch(/<button[^>]*\sdisabled=""/);
  });

  it('opens the builder once the chat is no longer busy', () => {
    const out = html(false);
    expect(out).toMatch(/href="\/skills\/new\?from=c1&amp;suggestion=t1"/);
  });
});
