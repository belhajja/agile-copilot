'use client';

import type { SyncStateView } from '@agile/sync';
import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useTransition } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { allowedCode } from '@/lib/error-code';
import { BOARD_ERROR_CODES } from '../error-codes';
import { discoverBoardsAction, requestSyncAction } from './actions';

const BUSY = new Set(['queued', 'running']);

/**
 * Sync status + "Sync now"; refreshes the page every 2 s while a sync is queued or running.
 * `label` and `error` are formatted on the server (no clock/time-zone mismatch on hydration).
 */
export function SyncControls({
  connectionId,
  status,
  label,
  error,
  canManage,
  hasSelection,
}: {
  connectionId: string;
  status: SyncStateView['status'];
  label: string;
  error: string | null;
  canManage: boolean;
  hasSelection: boolean;
}) {
  const t = useTranslations('boards');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const busy = BUSY.has(status);

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => router.refresh(), 2_000);
    return () => clearInterval(timer);
  }, [busy, router]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Badge
        variant={status === 'error' ? 'destructive' : status === 'ok' ? 'default' : 'secondary'}
      >
        {label}
      </Badge>
      {error && <span className="text-sm text-destructive">{error}</span>}
      {canManage && (
        <Button
          size="sm"
          disabled={pending || busy || !hasSelection}
          onClick={() =>
            startTransition(async () => {
              const r = await requestSyncAction(connectionId);
              if (r.status === 'error')
                toast.error(t(`errors.${allowedCode(r.code, BOARD_ERROR_CODES) ?? 'unknown'}`));
              else
                toast.success(
                  r.status === 'ok' && r.queued === false
                    ? t('sync.alreadyQueued')
                    : t('sync.requested'),
                );
              router.refresh();
            })
          }
        >
          <RefreshCw />
          {t('sync.now')}
        </Button>
      )}
    </div>
  );
}

/** Reads (or re-reads) the connection's boards from Jira. */
export function DiscoverBoardsButton({
  connectionId,
  label,
  variant = 'outline',
}: {
  connectionId: string;
  label: string;
  variant?: 'default' | 'outline';
}) {
  const t = useTranslations('boards');
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      variant={variant}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const r = await discoverBoardsAction(connectionId);
          if (r.status === 'error') {
            toast.error(t(`errors.${allowedCode(r.code, BOARD_ERROR_CODES) ?? 'unknown'}`));
          }
        })
      }
    >
      {label}
    </Button>
  );
}
