'use client';

import { PanelLeft, PanelLeftClose, PanelLeftOpen, SquarePen } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import type { HistoryGroup } from './group-conversations';

export interface HistoryItem {
  id: string;
  title: string;
  /** Formatted on the server (no time zone mismatch on hydration). */
  when: string;
}

const OPEN_KEY = 'agent-history-open';

/**
 * The assistant's frame: the conversation history on the left (collapsible, remembered in this
 * browser; a drawer on small screens) and the chat beside it.
 */
export function AgentShell({
  groups,
  currentId,
  children,
}: {
  groups: { key: HistoryGroup; items: HistoryItem[] }[];
  currentId: string;
  children: ReactNode;
}) {
  const t = useTranslations('agent');
  const [open, setOpen] = useState(true);
  const [drawer, setDrawer] = useState(false);

  // Storage can be missing or blocked (private windows): the panel then just starts open.
  useEffect(() => {
    try {
      if (localStorage.getItem(OPEN_KEY) === '0') setOpen(false);
    } catch {}
  }, []);
  const toggle = () =>
    setOpen((was) => {
      try {
        localStorage.setItem(OPEN_KEY, was ? '0' : '1');
      } catch {}
      return !was;
    });

  const history = (
    <HistoryList groups={groups} currentId={currentId} onNavigate={() => setDrawer(false)} />
  );
  const newChat = (
    <Button asChild variant="outline" className="justify-start">
      <Link href="/agent" onClick={() => setDrawer(false)}>
        <SquarePen aria-hidden />
        {t('newChat')}
      </Link>
    </Button>
  );

  return (
    <div
      data-wide
      className={cn(
        'grid h-[calc(100dvh-5rem)] min-h-96 min-w-0',
        open && 'md:grid-cols-[16rem_minmax(0,1fr)]',
      )}
    >
      {open && (
        <aside className="hidden min-h-0 flex-col gap-3 border-r pr-3 md:flex">
          {newChat}
          {history}
        </aside>
      )}
      <div className={cn('flex min-h-0 min-w-0 flex-col gap-2', open && 'md:pl-4')}>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            className="hidden md:inline-flex"
            onClick={toggle}
            aria-label={open ? t('hideHistory') : t('showHistory')}
            title={open ? t('hideHistory') : t('showHistory')}
            aria-expanded={open}
          >
            {open ? <PanelLeftClose /> : <PanelLeftOpen />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            onClick={() => setDrawer(true)}
            aria-label={t('openHistory')}
            title={t('openHistory')}
          >
            <PanelLeft />
          </Button>
          <h1 className="mr-auto text-base font-semibold tracking-tight">{t('title')}</h1>
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            className={cn(open && 'md:hidden')}
            aria-label={t('newChat')}
            title={t('newChat')}
          >
            <Link href="/agent">
              <SquarePen />
            </Link>
          </Button>
        </div>
        {children}
      </div>
      <Sheet open={drawer} onOpenChange={setDrawer}>
        <SheetContent side="left" className="w-72 gap-3 p-3">
          <SheetHeader className="p-0">
            <SheetTitle>{t('history')}</SheetTitle>
          </SheetHeader>
          {newChat}
          {history}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function HistoryList({
  groups,
  currentId,
  onNavigate,
}: {
  groups: { key: HistoryGroup; items: HistoryItem[] }[];
  currentId: string;
  onNavigate: () => void;
}) {
  const t = useTranslations('agent');
  if (groups.length === 0) return null;
  return (
    <nav
      aria-label={t('history')}
      className="-mr-2 grid min-h-0 content-start gap-4 overflow-y-auto pr-2"
    >
      {groups.map((g) => (
        <section key={g.key} className="grid gap-0.5">
          <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">
            {t(`historyGroups.${g.key}`)}
          </h2>
          {g.items.map((c) => {
            const current = c.id === currentId;
            return (
              <Link
                key={c.id}
                href={`/agent/${c.id}`}
                title={`${c.title} · ${c.when}`}
                aria-current={current ? 'page' : undefined}
                onClick={onNavigate}
                className={cn(
                  'truncate rounded-md px-2 py-1.5 text-sm hover:bg-muted',
                  current && 'bg-muted font-medium',
                )}
              >
                {c.title}
              </Link>
            );
          })}
        </section>
      ))}
    </nav>
  );
}
