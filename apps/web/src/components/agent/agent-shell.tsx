'use client';

import { PanelLeft, PanelLeftClose, PanelLeftOpen, SquarePen } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { HistoryList, type SidebarHistory } from './history-list';

const OPEN_KEY = 'agent-history-open';

/**
 * The assistant's frame: the conversation history on the left (collapsible, remembered in this
 * browser; a drawer on small screens) and the chat beside it.
 */
export function AgentShell({
  history,
  currentId,
  headerActions,
  children,
}: {
  history: SidebarHistory;
  currentId: string;
  /** Beside the title (the model picker). */
  headerActions?: ReactNode;
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

  const historyList = (
    <HistoryList history={history} currentId={currentId} onNavigate={() => setDrawer(false)} />
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
          {historyList}
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
          {headerActions}
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
          {historyList}
        </SheetContent>
      </Sheet>
    </div>
  );
}
