'use client';

import { Brain, ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

/**
 * The model's reasoning: open while it streams, so the reader sees what it is working on, and
 * folded once it is done (still available on demand).
 */
export function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const t = useTranslations('agent.reasoning');
  const [open, setOpen] = useState(streaming);
  useEffect(() => setOpen(streaming), [streaming]);
  if (!text.trim()) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0" data-reasoning>
      <CollapsibleTrigger className="group flex items-center gap-2 text-muted-foreground text-sm hover:text-foreground">
        <Brain className="size-4" aria-hidden />
        {streaming ? <Shimmer as="span">{t('live')}</Shimmer> : <span>{t('label')}</span>}
        <ChevronDown
          className="size-4 transition-transform group-data-[state=open]:rotate-180"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mt-2 max-h-64 overflow-y-auto border-l-2 pl-3 text-muted-foreground text-xs whitespace-pre-wrap">
          {text}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
