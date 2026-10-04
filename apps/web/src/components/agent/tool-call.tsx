'use client';

import type { ToolUIPart } from 'ai';
import { ChevronDown, Wrench } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CodeBlock } from '@/components/ai-elements/code-block';
import { Tool, ToolContent } from '@/components/ai-elements/tool';
import { Badge } from '@/components/ui/badge';
import { CollapsibleTrigger } from '@/components/ui/collapsible';
import { pinnedBoardId, readableOutput, readToolError } from './tool-output';

/** A failed tool call, translated from its code (plus the people Jira matched, if ambiguous). */
export function ToolError({ errorText }: { errorText: string | undefined }) {
  const t = useTranslations('agent.toolErrors');
  const { code, candidates } = readToolError(errorText);
  return (
    <div className="grid gap-1 text-sm text-destructive" data-tool-error={code ?? ''}>
      {/* Every code the agent reports has a sentence in both languages (tested); else generic. */}
      <p>{code ? t(code) : t('generic')}</p>
      {candidates.length > 0 && (
        <p className="wrap-anywhere text-muted-foreground">
          {t('candidates', { names: candidates.join(', ') })}
        </p>
      )}
    </div>
  );
}

/** A read tool call (analytics or Jira): collapsed by default, input and result on demand. */
export function ToolCall({ part, toolName }: { part: ToolUIPart; toolName: string }) {
  const t = useTranslations('agent');
  const running = part.state === 'input-streaming' || part.state === 'input-available';
  const pinnedTo =
    toolName === 'pin_widget' && part.state === 'output-available'
      ? pinnedBoardId(part.output)
      : undefined;
  return (
    <>
      <ToolDetails part={part} toolName={toolName} running={running} />
      {pinnedTo && (
        <Link href={`/boards/${pinnedTo}`} className="text-sm underline" data-pinned-board>
          {t('openDashboard')}
        </Link>
      )}
    </>
  );
}

function ToolDetails({
  part,
  toolName,
  running,
}: {
  part: ToolUIPart;
  toolName: string;
  running: boolean;
}) {
  const t = useTranslations('agent');
  return (
    <Tool data-tool={toolName} className="mb-0 min-w-0">
      <CollapsibleTrigger className="flex w-full min-w-0 items-center justify-between gap-2 p-3 text-left">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <Wrench className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 truncate text-sm font-medium">
            {t.has(`tools.${toolName}`) ? t(`tools.${toolName}`) : toolName}
          </span>
          <Badge variant={part.state === 'output-error' ? 'destructive' : 'secondary'}>
            {t(`status.${running ? 'running' : part.state === 'output-error' ? 'error' : 'done'}`)}
          </Badge>
        </span>
        <ChevronDown
          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
          aria-hidden
        />
      </CollapsibleTrigger>
      <ToolContent className="p-0">
        <div className="grid min-w-0 gap-3 p-3">
          <p className="text-xs font-medium uppercase text-muted-foreground">{t('input')}</p>
          <CodeBlock code={JSON.stringify(part.input ?? {}, null, 2)} language="json" />
          {part.state === 'output-available' && (
            <>
              <p className="text-xs font-medium uppercase text-muted-foreground">{t('result')}</p>
              <CodeBlock code={readableOutput(part.output)} language="json" />
            </>
          )}
          {part.state === 'output-error' && <ToolError errorText={part.errorText} />}
        </div>
      </ToolContent>
    </Tool>
  );
}
