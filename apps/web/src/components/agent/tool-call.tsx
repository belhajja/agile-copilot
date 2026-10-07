'use client';

import type { ToolUIPart } from 'ai';
import { ChevronDown, Sparkles, Wrench } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CodeBlock } from '@/components/ai-elements/code-block';
import { Tool, ToolContent } from '@/components/ai-elements/tool';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CollapsibleTrigger } from '@/components/ui/collapsible';
import { ResultCard } from './result-card';
import { toolLabel } from './tool-labels';
import {
  pinnableResultOf,
  pinnedBoardId,
  readableOutput,
  readToolError,
  type SkillSuggestion,
  skillSuggestionOf,
  suggestionHref,
} from './tool-output';

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
export function ToolCall({
  part,
  toolName,
  conversationId,
  busy,
}: {
  part: ToolUIPart;
  toolName: string;
  /** For the skill builder link of a suggestion. */
  conversationId: string;
  /** Whether the chat is still submitting or streaming (the suggestion's link stays off until then). */
  busy: boolean;
}) {
  const t = useTranslations('agent');
  const running = part.state === 'input-streaming' || part.state === 'input-available';
  const done = part.state === 'output-available';
  const pinnedTo = toolName === 'pin_widget' && done ? pinnedBoardId(part.output) : undefined;
  const suggestion =
    toolName === 'suggest_skill' && done ? skillSuggestionOf(part.output) : undefined;
  if (suggestion) {
    const href = suggestionHref(conversationId, part.toolCallId, busy);
    return <SkillSuggestionCard suggestion={suggestion} href={href} />;
  }
  const result =
    done && (toolName === 'query_board' || toolName === 'get_metric')
      ? pinnableResultOf(toolName, part.output)
      : undefined;
  return (
    <>
      <ToolDetails part={part} toolName={toolName} running={running} />
      {result && <ResultCard result={result} />}
      {pinnedTo && (
        <Link href={`/boards/${pinnedTo}`} className="text-sm underline" data-pinned-board>
          {t('openDashboard')}
        </Link>
      )}
    </>
  );
}

/** A proposed skill: what it is, and the way to review it in the builder (nothing is saved here). */
function SkillSuggestionCard({
  suggestion,
  href,
}: {
  suggestion: SkillSuggestion;
  /** Undefined while the reply is still streaming: the link is not live yet. */
  href: string | undefined;
}) {
  const t = useTranslations('agent.suggestion');
  const ts = useTranslations('skills');
  const posts = suggestion.trigger === 'schedule' || suggestion.trigger === 'alert';
  return (
    <div className="grid min-w-0 gap-3 rounded-lg border p-3" data-skill-suggestion>
      <p className="flex items-center gap-2 text-sm font-medium">
        <Sparkles className="size-4 text-muted-foreground" aria-hidden />
        {t('title')}
      </p>
      <div className="grid min-w-0 gap-1">
        <p className="truncate font-mono text-sm">{suggestion.name}</p>
        {suggestion.description && (
          <p className="text-sm text-muted-foreground">{suggestion.description}</p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Badge variant="secondary">{ts(`triggers.${suggestion.trigger}`)}</Badge>
        {posts && <Badge variant="outline">{ts(`outputs.${suggestion.output}`)}</Badge>}
      </div>
      {href ? (
        <Button asChild size="sm" className="justify-self-start">
          <Link href={href}>{t('open')}</Link>
        </Button>
      ) : (
        <Button size="sm" className="justify-self-start" disabled>
          {t('open')}
        </Button>
      )}
    </div>
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
          <span className="min-w-0 truncate text-sm font-medium">{toolLabel(t, toolName)}</span>
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
              <p className="text-xs font-medium uppercase text-muted-foreground">
                {t('resultLabel')}
              </p>
              <CodeBlock code={readableOutput(part.output)} language="json" />
            </>
          )}
          {part.state === 'output-error' && <ToolError errorText={part.errorText} />}
        </div>
      </ToolContent>
    </Tool>
  );
}
