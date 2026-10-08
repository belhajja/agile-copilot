'use client';

import { Pin } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { type PinResultActionResult, pinResultAction } from '@/app/(app)/agent/actions';
import { DASHBOARD_METRICS } from '@/components/dashboard/message-keys';
import { WidgetBody, WidgetNotes } from '@/components/dashboard/widget-body';
import { JiraSiteProvider, useBoardSite } from '@/components/jira-issue-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { allowedCode } from '@/lib/error-code';
import type { PinnableResult } from './tool-output';

type PinState =
  | { status: 'idle' }
  | { status: 'pinned'; boardId: string; alreadyPinned: boolean }
  | { status: 'error'; code: Extract<PinResultActionResult, { ok: false }>['code'] };

/**
 * A query_board or get_metric result as the dashboard would show it, with its board and time, and
 * a button to pin it. The chart is the answer's snapshot; the pinned widget is recomputed live.
 */
export function ResultCard({ result }: { result: PinnableResult }) {
  const t = useTranslations('agent');
  const td = useTranslations('dashboards');
  const format = useFormatter();
  const [state, setState] = useState<PinState>({ status: 'idle' });
  const [pending, startTransition] = useTransition();
  const jiraBaseUrl = useBoardSite(result.board.id);
  const metric = allowedCode(result.widget.metric, DASHBOARD_METRICS);
  const title =
    result.widget.title ??
    (metric && metric !== 'query'
      ? td(`metrics.${metric}.title`, result.widget.params as never)
      : (metric ?? ''));
  const pin = () =>
    startTransition(async () => {
      const r = await pinResultAction({ boardId: result.board.id, widget: result.widget });
      setState(
        r.ok
          ? { status: 'pinned', boardId: r.boardId, alreadyPinned: r.alreadyPinned }
          : { status: 'error', code: r.code },
      );
    });
  return (
    <div className="grid min-w-0 gap-3 rounded-lg border p-3" data-query-result>
      <div className="grid gap-0.5">
        <p className="text-sm font-medium">{title}</p>
        {result.computedAt && (
          <p className="text-xs text-muted-foreground">
            {t('result.asOf', {
              board: result.board.name,
              time: format.dateTime(new Date(result.computedAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              }),
            })}
          </p>
        )}
      </div>
      <div className="min-w-0 overflow-x-auto">
        <JiraSiteProvider baseUrl={jiraBaseUrl}>
          <WidgetBody data={result.data} title={title} />
        </JiraSiteProvider>
      </div>
      <WidgetNotes data={result.data} />
      <div className="flex flex-wrap items-center gap-2">
        {state.status === 'pinned' ? (
          <>
            <Badge variant="secondary" data-already-pinned={state.alreadyPinned || undefined}>
              {state.alreadyPinned ? t('result.alreadyPinned') : t('result.pinned')}
            </Badge>
            <Link href={`/boards/${state.boardId}`} className="text-sm underline" data-pinned-board>
              {t('openDashboard')}
            </Link>
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={pin} disabled={pending}>
            <Pin aria-hidden />
            {t('result.pin')}
          </Button>
        )}
        {state.status === 'error' && (
          <p className="text-sm text-destructive">{t(`result.pinErrors.${state.code}`)}</p>
        )}
      </div>
    </div>
  );
}
