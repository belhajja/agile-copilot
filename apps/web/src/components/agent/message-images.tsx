'use client';

import type { FileUIPart } from 'ai';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

/**
 * The images of a user message as thumbnails; each opens full size. Their urls are this app's
 * (`/api/agent/attachments/…`) or, just after sending, data URLs: never another origin's.
 */
export function MessageImages({ parts }: { parts: FileUIPart[] }) {
  const t = useTranslations('agent.images');
  const [open, setOpen] = useState<number | null>(null);
  if (parts.length === 0) return null;
  const shown = open === null ? undefined : parts[open];
  return (
    <div className="flex flex-wrap justify-end gap-2" data-message-images>
      {parts.map((part, i) => (
        <button
          // A message's images never move: their position is their identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          key={i}
          type="button"
          className="overflow-hidden rounded-lg border bg-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          onClick={() => setOpen(i)}
          aria-label={t('open', { n: i + 1 })}
        >
          {/* biome-ignore lint/performance/noImgElement: a private, same-origin or data URL image */}
          <img src={part.url} alt={t('alt', { n: i + 1 })} className="size-24 object-cover" />
        </button>
      ))}
      <Dialog open={shown !== undefined} onOpenChange={(o) => !o && setOpen(null)}>
        {shown && open !== null && (
          <DialogContent
            className="max-w-[min(92vw,64rem)] sm:max-w-[min(92vw,64rem)]"
            aria-describedby={undefined}
          >
            <DialogTitle>{t('alt', { n: open + 1 })}</DialogTitle>
            {/* biome-ignore lint/performance/noImgElement: a private, same-origin or data URL image */}
            <img
              src={shown.url}
              alt={t('alt', { n: open + 1 })}
              className="mx-auto max-h-[80vh] w-auto object-contain"
            />
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
