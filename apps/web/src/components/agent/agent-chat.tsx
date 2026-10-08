'use client';

import { MESSAGE_MAX_LENGTH } from '@agile/agent/limits';
import { turnErrorCode } from '@agile/agent/turn-errors';
import { isJiraWriteTool } from '@agile/jira-tools/catalog';
import { useChat } from '@ai-sdk/react';
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessage,
} from 'ai';
import { Bot } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message, MessageContent } from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from '@/components/ai-elements/prompt-input';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { AgentMarkdown } from './agent-markdown';
import { ApprovalCard } from './approval-card';
import { approvalView } from './approval-view';
import { type ChatErrorKey, chatErrorKey, toAgentRequest } from './request';
import { ToolCall } from './tool-call';

// Not a failure of the request itself: the decision was already settled elsewhere.
const NEUTRAL_ERRORS: ReadonlySet<ChatErrorKey> = new Set(['alreadyDecided', 'approvalNotFound']);

/** Starter questions on an empty chat (`agent.suggestions.*`). */
const SUGGESTIONS = ['velocity', 'risks', 'blockers', 'forecast'] as const;

/** The width of the message column and the composer. */
const COLUMN = 'mx-auto w-full max-w-3xl';

export function AgentChat({
  conversationId,
  initialMessages,
  siteNames,
  siteUrls,
}: {
  conversationId: string;
  initialMessages: UIMessage[];
  /** Jira connection id → name, for the site row of approval cards. */
  siteNames: Readonly<Record<string, string>>;
  /** Jira connection id → base URL, to link issue keys. */
  siteUrls: Readonly<Record<string, string>>;
}) {
  const t = useTranslations('agent');
  const [text, setText] = useState('');
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/agent/chat',
        prepareSendMessagesRequest: ({ id, messages }) => ({ body: toAgentRequest(id, messages) }),
      }),
    [],
  );
  const { messages, sendMessage, addToolApprovalResponse, status, error } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport,
    // After Approve/Reject the decision is sent at once; the server runs (or skips) the change.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });
  const busy = status === 'submitted' || status === 'streaming';
  const errorKey = error ? chatErrorKey(error) : undefined;
  const atLimit = text.length >= MESSAGE_MAX_LENGTH;

  const send = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    void sendMessage({ text: trimmed });
    setText('');
  };

  const composer = (
    <PromptInput
      className={cn(
        COLUMN,
        '[&_[data-slot=input-group]]:rounded-2xl [&_[data-slot=input-group]]:shadow-sm',
      )}
      onSubmit={({ text: value }) => send(value)}
    >
      <PromptInputBody>
        <PromptInputTextarea
          aria-label={t('inputLabel')}
          aria-describedby={atLimit ? 'agent-input-limit' : undefined}
          placeholder={t('placeholder')}
          maxLength={MESSAGE_MAX_LENGTH}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
        />
      </PromptInputBody>
      <PromptInputFooter className="justify-end gap-2">
        {atLimit && (
          <p id="agent-input-limit" className="mr-auto text-muted-foreground text-xs" data-too-long>
            {t('tooLong')}
          </p>
        )}
        <PromptInputSubmit
          status={status}
          disabled={busy || !text.trim()}
          aria-label={t('send')}
          title={t('send')}
        />
      </PromptInputFooter>
    </PromptInput>
  );

  const errorAlert = errorKey && (
    <Alert
      className={COLUMN}
      variant={NEUTRAL_ERRORS.has(errorKey) ? 'default' : 'destructive'}
      data-chat-error={errorKey}
    >
      <AlertDescription>{t(`errors.${errorKey}`)}</AlertDescription>
    </Alert>
  );

  // A new chat: the greeting, the composer and starter questions, centred.
  if (messages.length === 0) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-2 pb-8">
        <div className="grid justify-items-center gap-2 text-center">
          <Bot className="size-8 text-muted-foreground" aria-hidden />
          <h2 className="text-2xl font-semibold tracking-tight">{t('emptyTitle')}</h2>
          <p className="max-w-xl text-muted-foreground text-sm">{t('emptyHint')}</p>
        </div>
        {errorAlert}
        {composer}
        <div className={cn(COLUMN, 'flex flex-wrap justify-center gap-2')}>
          {SUGGESTIONS.map((s) => (
            <Button
              key={s}
              type="button"
              variant="outline"
              size="sm"
              className="h-auto rounded-full py-1.5 whitespace-normal"
              disabled={busy}
              onClick={() => send(t(`suggestions.${s}`))}
            >
              {t(`suggestions.${s}`)}
            </Button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <Conversation className="min-w-0">
        <ConversationContent className={cn(COLUMN, 'gap-6 px-2 py-4 sm:px-4')}>
          {messages.map((m, index) => (
            <Message from={m.role} key={m.id} data-role={m.role}>
              <MessageContent className="break-words">
                {m.parts.map((part, i) => {
                  const key = `${m.id}-${i}`;
                  if (part.type === 'text') {
                    return m.role === 'assistant' ? (
                      <AgentMarkdown key={key}>{part.text}</AgentMarkdown>
                    ) : (
                      <p key={key} className="whitespace-pre-wrap">
                        {part.text}
                      </p>
                    );
                  }
                  const turnError = turnErrorCode(part);
                  if (turnError) {
                    return (
                      <Alert key={key} variant="destructive" data-turn-error={turnError}>
                        <AlertDescription>{t(`turnErrors.${turnError}`)}</AlertDescription>
                      </Alert>
                    );
                  }
                  if (!isToolUIPart(part) || part.type === 'dynamic-tool') return null;
                  const name = getToolName(part);
                  const latest = index === messages.length - 1;
                  return isJiraWriteTool(name) ? (
                    <ApprovalCard
                      key={key}
                      part={part}
                      toolName={name}
                      view={approvalView(part, latest)}
                      siteNames={siteNames}
                      siteUrls={siteUrls}
                      disabled={busy}
                      notSent={latest && status === 'error' && part.state === 'approval-responded'}
                      onDecision={(id, approved) => addToolApprovalResponse({ id, approved })}
                    />
                  ) : (
                    <ToolCall
                      key={key}
                      part={part}
                      toolName={name}
                      conversationId={conversationId}
                      busy={busy}
                    />
                  );
                })}
              </MessageContent>
            </Message>
          ))}
          {status === 'submitted' && <Shimmer>{t('thinking')}</Shimmer>}
        </ConversationContent>
        <ConversationScrollButton aria-label={t('scrollDown')} title={t('scrollDown')} />
      </Conversation>
      {errorAlert}
      <div className="px-2 pb-1">{composer}</div>
    </div>
  );
}
