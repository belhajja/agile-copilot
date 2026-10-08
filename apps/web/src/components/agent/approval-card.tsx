'use client';

import type { ToolUIPart } from 'ai';
import { Check, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation';
import { JiraIssueLink } from '@/components/jira-issue-link';
import { APPROVAL_FIELDS, CONVERTED_FIELDS } from './approval-fields';
import type { ApprovalView } from './approval-view';
import { ToolError } from './tool-call';
import { toolLabel } from './tool-labels';
import { assignedTo } from './tool-output';

/**
 * A proposed Jira change: exactly what will be sent (tool and arguments), with Approve / Reject.
 * The decision goes to the server, which records it (audit log) before anything reaches Jira.
 */
export function ApprovalCard({
  part,
  toolName,
  view,
  siteNames,
  siteUrls,
  disabled,
  notSent,
  onDecision,
}: {
  part: ToolUIPart;
  toolName: string;
  /** How to show it (see `approvalView`): a stale proposal is shown closed. */
  view: ApprovalView;
  /** Jira connection id → name, to show the site by name. */
  siteNames: Readonly<Record<string, string>>;
  /** Jira connection id → base URL, to link the issue key. */
  siteUrls: Readonly<Record<string, string>>;
  disabled: boolean;
  /**
   * The decision was taken here but its request failed. Resending it cannot help (the server
   * closes an approved change it could not run): the user asks again instead.
   */
  notSent: boolean;
  onDecision: (approvalId: string, approved: boolean) => void;
}) {
  const t = useTranslations('agent');
  const input = (part.input ?? {}) as Record<string, unknown>;
  const rows = APPROVAL_FIELDS.filter((f) => input[f] !== undefined && input[f] !== '');
  // The change's site; without one the workspace has a single site, which is it.
  const urls = Object.values(siteUrls);
  const siteUrl =
    typeof input.site === 'string'
      ? Object.hasOwn(siteUrls, input.site)
        ? siteUrls[input.site]
        : null
      : urls.length === 1
        ? urls[0]
        : null;
  const show = (f: string, v: unknown): ReactNode =>
    Array.isArray(v) ? (
      v.join(', ')
    ) : f === 'site' ? (
      typeof v === 'string' && Object.hasOwn(siteNames, v) ? (
        siteNames[v]
      ) : (
        t('unknownSite')
      )
    ) : f === 'issueKey' && typeof v === 'string' ? (
      <JiraIssueLink issueKey={v} baseUrl={siteUrl} />
    ) : (
      String(v)
    );
  const assignee = view.state === 'output-available' ? assignedTo(part.output) : undefined;
  const closed =
    view.closedBy === 'superseded'
      ? t('superseded')
      : view.closedBy === 'forbidden_role'
        ? t('forbiddenRole')
        : t('rejected');
  return (
    <Confirmation
      approval={view.approval}
      state={view.state}
      data-approval={part.approval?.id}
      data-state={view.state}
      data-closed-by={view.closedBy}
      className="max-w-full min-w-0"
    >
      <ConfirmationTitle>
        <span className="font-medium">{toolLabel(t, toolName)}</span>
        {typeof input.issueKey === 'string' && (
          <>
            {' · '}
            <JiraIssueLink issueKey={input.issueKey} baseUrl={siteUrl} />
          </>
        )}
      </ConfirmationTitle>
      <dl className="grid min-w-0 gap-2 text-sm">
        {rows.map((f) => (
          <div key={f} className="grid min-w-0 gap-0.5">
            <dt className="text-muted-foreground">{t(`fields.${f}`)}</dt>
            <dd className="min-w-0 whitespace-pre-wrap wrap-anywhere rounded-md bg-muted/50 px-2 py-1">
              {show(f, input[f])}
            </dd>
            {CONVERTED_FIELDS.has(f) && (
              <dd className="text-xs text-muted-foreground">{t('markupHint')}</dd>
            )}
          </div>
        ))}
      </dl>
      <ConfirmationRequest>
        <p className="text-muted-foreground text-sm">{t('approvalHint')}</p>
      </ConfirmationRequest>
      <ConfirmationAccepted>
        <p className="flex items-center gap-1 text-sm">
          <Check className="size-4 shrink-0" aria-hidden /> {t('approved')}
        </p>
        {assignee && <p className="text-sm">{t('assignedTo', { name: assignee })}</p>}
      </ConfirmationAccepted>
      <ConfirmationRejected>
        <p className="flex items-center gap-1 text-sm">
          <X className="size-4 shrink-0" aria-hidden />
          {closed}
        </p>
      </ConfirmationRejected>
      {notSent && (
        <p className="text-destructive text-sm" data-not-sent>
          {t('notSent')}
        </p>
      )}
      {part.state === 'output-error' && <ToolError errorText={part.errorText} />}
      <ConfirmationActions className="flex-wrap">
        <ConfirmationAction
          variant="outline"
          disabled={disabled}
          onClick={() => part.approval && onDecision(part.approval.id, false)}
        >
          {t('reject')}
        </ConfirmationAction>
        <ConfirmationAction
          disabled={disabled}
          onClick={() => part.approval && onDecision(part.approval.id, true)}
        >
          {t('approve')}
        </ConfirmationAction>
      </ConfirmationActions>
    </Confirmation>
  );
}
