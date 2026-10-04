import { render } from '@react-email/render';
import { createElement as h, type ReactElement } from 'react';

export interface DigestEmailProps {
  lang: 'en' | 'fr';
  title: string;
  /** The report (the model's Markdown, shown as plain text paragraphs: never parsed as HTML). */
  body: string;
  link?: string;
  linkLabel: string;
  footer: string;
}

const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const text = { fontSize: 14, lineHeight: '22px', margin: '0 0 12px', color: '#111827' };

/**
 * A skill report as an email (React, rendered by React Email). Deliberately plain: the report is
 * text (React escapes it), there are no images or remote styles, so opening it loads nothing.
 * Written with `createElement` so this server-only package needs no JSX toolchain.
 */
export function DigestEmail({ lang, title, body, link, linkLabel, footer }: DigestEmailProps) {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const content: ReactElement[] = [
    h(
      'h1',
      {
        key: 'title',
        style: { fontSize: 20, lineHeight: '28px', margin: '0 0 16px', color: '#111827' },
      },
      title,
    ),
    ...paragraphs.map((p, i) =>
      h('p', { key: `p${i}`, style: { ...text, whiteSpace: 'pre-wrap' } }, p),
    ),
  ];
  if (link) {
    content.push(
      h(
        'p',
        { key: 'link', style: { margin: '20px 0 0' } },
        h('a', { href: link, style: { color: '#2563eb', fontSize: 14 } }, linkLabel),
      ),
    );
  }
  content.push(
    h('hr', {
      key: 'rule',
      style: { border: 'none', borderTop: '1px solid #e5e7eb', margin: '24px 0 12px' },
    }),
    h(
      'p',
      { key: 'footer', style: { fontSize: 12, lineHeight: '18px', color: '#6b7280', margin: 0 } },
      footer,
    ),
  );
  return h(
    'html',
    { lang },
    h(
      'head',
      null,
      h('meta', { httpEquiv: 'Content-Type', content: 'text/html; charset=UTF-8' }),
      h('title', null, title),
    ),
    h(
      'body',
      { style: { backgroundColor: '#f6f7f9', margin: 0, padding: '24px 0', fontFamily: font } },
      h(
        'table',
        {
          role: 'presentation',
          width: '100%',
          cellPadding: 0,
          cellSpacing: 0,
          style: { maxWidth: 600, margin: '0 auto', backgroundColor: '#ffffff', borderRadius: 8 },
        },
        h('tbody', null, h('tr', null, h('td', { style: { padding: 24 } }, ...content))),
      ),
    ),
  );
}

/** HTML and plain-text versions of a digest email. */
export async function renderDigestEmail(props: DigestEmailProps) {
  const element = h(DigestEmail, props);
  return {
    html: await render(element),
    text: await render(element, { plainText: true }),
  };
}
