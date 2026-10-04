'use client';

import type { ToolUIPart } from 'ai';
import { Check, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation';
import { ToolError } from './tool-call';
import { assignedTo } from './tool-output';

const FIELDS = [
  'site',
  'issueKey',
  'projectKey',
  'issueType',
  'summary',
  'transitionId',
  'assignee',
  'labels',
  'description',
  'body',
  'comment',
] as const;

// Free text the Jira backends convert from Markdown to Jira wiki markup before sending.
const CONVERTED = new Set<string>(['description', 'body', 'comment']);

/**
 * A proposed Jira change: exactly what will be sent (tool and arguments), with Approve / Reject.
 * The decision goes to the server, which records it (audit log) before anything reaches Jira.
 */
export function ApprovalCard({
  part,
  toolName,
  disabled,
  onDecision,
}: {
  part: ToolUIPart;
  toolName: string;
  disabled: boolean;
  onDecision: (approvalId: string, approved: boolean) => void;
}) {
  const t = useTranslations('agent');
  const input = (part.input ?? {}) as Record<string, unknown>;
  const rows = FIELDS.filter((f) => input[f] !== undefined && input[f] !== '');
  const show = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v));
  const assignee = part.state === 'output-available' ? assignedTo(part.output) : undefined;
  return (
    <Confirmation
      approval={part.approval}
      state={part.state}
      data-approval={part.approval?.id}
      data-state={part.state}
      className="max-w-full min-w-0"
    >
      <ConfirmationTitle>
        <span className="font-medium">
          {t.has(`tools.${toolName}`) ? t(`tools.${toolName}`) : toolName}
        </span>
        {typeof input.issueKey === 'string' ? ` · ${input.issueKey}` : ''}
      </ConfirmationTitle>
      <dl className="grid min-w-0 gap-2 text-sm">
        {rows.map((f) => (
          <div key={f} className="grid min-w-0 gap-0.5">
            <dt className="text-muted-foreground">{t(`fields.${f}`)}</dt>
            <dd className="min-w-0 whitespace-pre-wrap wrap-anywhere rounded-md bg-muted/50 px-2 py-1">
              {show(input[f])}
            </dd>
            {CONVERTED.has(f) && (
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
          {part.approval?.reason === 'superseded' ? t('superseded') : t('rejected')}
        </p>
      </ConfirmationRejected>
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
