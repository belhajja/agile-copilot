import { asUntrustedData } from '@agile/agent/untrusted';
import type { ToolUIPart } from 'ai';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
// ResultCard pulls in the server action module; this test never renders it, but the import must
// not blow up on the server-only guard.
vi.mock('@/app/(app)/agent/actions', () => ({ pinResultAction: async () => ({ ok: true }) }));

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

  it('says why the link is off, tied to the button', () => {
    const out = html(true);
    const describedBy = out.match(/<button[^>]*aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    expect(out).toContain(`id="${describedBy}"`);
    expect(out).toContain('waiting');
    expect(html(false)).not.toContain('waiting');
  });

  it('opens the builder once the chat is no longer busy', () => {
    const out = html(false);
    expect(out).toMatch(/href="\/skills\/new\?from=c1&amp;suggestion=t1"/);
  });
});

describe('ToolCall (follow-ups)', () => {
  const followups = (state: string, output?: unknown) =>
    ({
      type: 'tool-suggest_followups',
      toolCallId: 'f1',
      state,
      input: { suggestions: ['Show the detail for Alice', 'Compare with sprint 11'] },
      output,
    }) as unknown as ToolUIPart;
  const render = (p: ToolUIPart, opts: { busy?: boolean; onFollowup?: (t: string) => void }) =>
    renderToString(
      createElement(ToolCall, {
        part: p,
        toolName: 'suggest_followups',
        conversationId: 'c1',
        busy: opts.busy ?? false,
        onFollowup: opts.onFollowup,
      }),
    );
  const done = followups('output-available', {
    suggestions: ['Show the detail for Alice', 'Compare with sprint 11'],
  });

  it('shows one button per follow-up on the latest reply, not the tool details', () => {
    const out = render(done, { onFollowup: () => {} });
    expect(out).toContain('data-followups');
    expect(out.match(/<button/g)).toHaveLength(2);
    expect(out).toContain('Show the detail for Alice');
    expect(out).not.toContain('data-tool=');
    expect(out).not.toMatch(/disabled=""/);
  });

  it('disables them while the chat is busy', () => {
    expect(render(done, { busy: true, onFollowup: () => {} })).toMatch(/<button[^>]*disabled=""/);
  });

  it('hides them on older replies, while streaming and when malformed', () => {
    expect(render(done, {})).toBe('');
    expect(render(followups('input-available'), { onFollowup: () => {} })).toBe('');
    expect(render(followups('output-available', 'nope'), { onFollowup: () => {} })).toBe('');
    expect(render(followups('output-error'), { onFollowup: () => {} })).toBe('');
  });
});
