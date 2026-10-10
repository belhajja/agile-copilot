'use client';

import type { ImageMediaType } from '@agile/agent/images';
import { MESSAGE_MAX_LENGTH } from '@agile/agent/limits';
import { turnErrorCode } from '@agile/agent/turn-errors';
import { isJiraWriteTool } from '@agile/jira-tools/catalog';
import { useChat } from '@ai-sdk/react';
import {
  DefaultChatTransport,
  type FileUIPart,
  getToolName,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessage,
} from 'ai';
import { Bot, ImagePlus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  type ClipboardEvent,
  type DragEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message, MessageContent } from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
} from '@/components/ai-elements/prompt-input';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { activityOf } from './activity';
import { AgentMarkdown } from './agent-markdown';
import { ApprovalCard } from './approval-card';
import { approvalView } from './approval-view';
import { acceptImages, IMAGE_ACCEPT, imagePartsOf, readAsDataUrl } from './images';
import { MessageImages } from './message-images';
import { ReasoningBlock } from './reasoning-block';
import { type ChatErrorKey, chatErrorKey, imageErrorKey, toAgentRequest } from './request';
import { ToolCall } from './tool-call';
import { toolLabel } from './tool-labels';

// Not a failure of the request itself: the decision was already settled elsewhere.
const NEUTRAL_ERRORS: ReadonlySet<ChatErrorKey> = new Set(['alreadyDecided', 'approvalNotFound']);

/** Starter questions on an empty chat (`agent.suggestions.*`). */
const SUGGESTIONS = ['velocity', 'risks', 'blockers', 'forecast'] as const;

/** The width of the message column and the composer. */
const COLUMN = 'mx-auto w-full max-w-3xl';

/** An image attached in the composer, not sent yet. */
interface PendingImage {
  id: string;
  file: File;
  mediaType: ImageMediaType;
  /** Object URL of the thumbnail; revoked when the image leaves the composer. */
  preview: string;
}

const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files');

export function AgentChat({
  conversationId,
  initialMessages,
  siteNames,
  siteUrls,
  acceptsImages,
}: {
  conversationId: string;
  initialMessages: UIMessage[];
  /** The conversation's model reads images: the composer takes them. */
  acceptsImages: boolean;
  /** Jira connection id → name, for the site row of approval cards. */
  siteNames: Readonly<Record<string, string>>;
  /** Jira connection id → base URL, to link issue keys. */
  siteUrls: Readonly<Record<string, string>>;
}) {
  const t = useTranslations('agent');
  const [text, setText] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const [imageError, setImageError] = useState<ChatErrorKey | null>(null);
  const [preparing, setPreparing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageErrorId = useId();
  // The latest list, for checks made while files are being read and for the unmount cleanup.
  const imagesRef = useRef(images);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);
  useEffect(
    () => () => {
      for (const image of imagesRef.current) URL.revokeObjectURL(image.preview);
    },
    [],
  );
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
  const activity = activityOf(messages, status);
  const errorKey = error ? chatErrorKey(error) : undefined;
  const atLimit = text.length >= MESSAGE_MAX_LENGTH;

  const send = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    void sendMessage({ text: trimmed });
    setText('');
  };

  /** Files picked, pasted or dropped: checked like the server checks them, then shown. */
  const addImages = async (files: File[]) => {
    if (files.length === 0) return;
    if (!acceptsImages) {
      setImageError('imagesNotSupported');
      return;
    }
    const { accepted, refusal } = await acceptImages(imagesRef.current.length, files);
    setImageError(refusal ? imageErrorKey(refusal) : null);
    if (accepted.length === 0) return;
    const added = accepted.map(({ file, mediaType }) => ({
      id: crypto.randomUUID(),
      file,
      mediaType,
      preview: URL.createObjectURL(file),
    }));
    imagesRef.current = [...imagesRef.current, ...added];
    setImages(imagesRef.current);
  };

  const removeImage = (id: string) => {
    const gone = imagesRef.current.find((i) => i.id === id);
    if (gone) URL.revokeObjectURL(gone.preview);
    imagesRef.current = imagesRef.current.filter((i) => i.id !== id);
    setImages(imagesRef.current);
    setImageError(null);
  };

  /** The composer's message: its text and the images attached, either may be empty. */
  const submit = async (value: string) => {
    const trimmed = value.trim();
    const attached = imagesRef.current;
    if ((!trimmed && attached.length === 0) || busy || preparing) return;
    if (attached.length > 0 && !acceptsImages) {
      setImageError('imagesNotSupported');
      return;
    }
    setPreparing(true);
    try {
      const files: FileUIPart[] = await Promise.all(
        attached.map(async (i) => ({
          type: 'file' as const,
          mediaType: i.mediaType,
          url: await readAsDataUrl(i.file, i.mediaType),
        })),
      );
      void sendMessage(trimmed ? { text: trimmed, files } : { files });
      setText('');
      for (const i of attached) URL.revokeObjectURL(i.preview);
      imagesRef.current = [];
      setImages([]);
      setImageError(null);
    } catch {
      setImageError('generic');
    } finally {
      setPreparing(false);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (files.length === 0) return;
    e.preventDefault();
    void addImages(files);
  };
  // Capture phase: dropped files are handled here, not by the prompt input's own file list.
  const onDragOver = (e: DragEvent) => {
    if (hasFiles(e)) e.preventDefault();
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    void addImages([...e.dataTransfer.files]);
  };

  const describedBy =
    [atLimit && 'agent-input-limit', imageError && imageErrorId].filter(Boolean).join(' ') ||
    undefined;
  const composer = (
    <div className={COLUMN} onDragOverCapture={onDragOver} onDropCapture={onDrop}>
      <PromptInput
        className="[&_[data-slot=input-group]]:rounded-2xl [&_[data-slot=input-group]]:shadow-sm"
        onSubmit={({ text: value }) => submit(value)}
      >
        {images.length > 0 && (
          <PromptInputHeader className="gap-2 px-3 pt-3" data-pending-images>
            {images.map((image, i) => (
              <div key={image.id} className="relative">
                {/* biome-ignore lint/performance/noImgElement: a local preview (blob URL) */}
                <img
                  src={image.preview}
                  alt={t('images.alt', { n: i + 1 })}
                  className="size-16 rounded-lg border object-cover"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  className="absolute -top-2 -right-2 size-6 rounded-full border shadow-sm"
                  onClick={() => removeImage(image.id)}
                  aria-label={t('images.remove', { n: i + 1 })}
                  title={t('images.remove', { n: i + 1 })}
                >
                  <X aria-hidden />
                </Button>
              </div>
            ))}
          </PromptInputHeader>
        )}
        <PromptInputBody>
          <PromptInputTextarea
            aria-label={t('inputLabel')}
            aria-describedby={describedBy}
            placeholder={t('placeholder')}
            maxLength={MESSAGE_MAX_LENGTH}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            onPaste={onPaste}
          />
        </PromptInputBody>
        <PromptInputFooter className="justify-end gap-2">
          {acceptsImages && (
            <>
              <input
                ref={fileInput}
                type="file"
                accept={IMAGE_ACCEPT}
                multiple
                hidden
                onChange={(e) => {
                  void addImages([...(e.currentTarget.files ?? [])]);
                  e.currentTarget.value = '';
                }}
              />
              <PromptInputButton
                onClick={() => fileInput.current?.click()}
                disabled={busy || preparing}
                aria-label={t('images.attach')}
                title={`${t('images.attach')} (${t('images.dropHint')})`}
                data-attach-images
              >
                <ImagePlus aria-hidden />
              </PromptInputButton>
            </>
          )}
          <div className="mr-auto grid gap-0.5">
            {imageError && (
              <p
                id={imageErrorId}
                role="alert"
                className="text-destructive text-xs"
                data-image-error
              >
                {t(`errors.${imageError}`)}
              </p>
            )}
            {atLimit && (
              <p id="agent-input-limit" className="text-muted-foreground text-xs" data-too-long>
                {t('tooLong')}
              </p>
            )}
          </div>
          <PromptInputSubmit
            status={status}
            disabled={busy || preparing || (!text.trim() && images.length === 0)}
            aria-label={t('send')}
            title={t('send')}
          />
        </PromptInputFooter>
      </PromptInput>
    </div>
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
                {m.role === 'user' && <MessageImages parts={imagePartsOf(m)} />}
                {m.parts.map((part, i) => {
                  const key = `${m.id}-${i}`;
                  const latest = index === messages.length - 1;
                  if (part.type === 'text') {
                    return m.role === 'assistant' ? (
                      <AgentMarkdown key={key}>{part.text}</AgentMarkdown>
                    ) : (
                      <p key={key} className="whitespace-pre-wrap">
                        {part.text}
                      </p>
                    );
                  }
                  if (part.type === 'reasoning') {
                    return (
                      <ReasoningBlock
                        key={key}
                        text={part.text}
                        streaming={busy && part.state === 'streaming'}
                      />
                    );
                  }
                  const turnError = turnErrorCode(part);
                  if (turnError) {
                    return (
                      <Alert key={key} variant="destructive" data-turn-error={turnError}>
                        <AlertDescription>{t(`turnErrors.${turnError}`)}</AlertDescription>
                        {latest && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="mt-2 justify-self-start text-foreground"
                            disabled={busy}
                            onClick={() => send(t('continueMessage'))}
                            data-continue
                          >
                            {t('continue')}
                          </Button>
                        )}
                      </Alert>
                    );
                  }
                  if (!isToolUIPart(part) || part.type === 'dynamic-tool') return null;
                  const name = getToolName(part);
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
                      onFollowup={latest ? send : undefined}
                    />
                  );
                })}
              </MessageContent>
            </Message>
          ))}
          {activity && activity.kind !== 'reasoning' && (
            <div role="status" aria-live="polite" data-activity={activity.kind}>
              <Shimmer>
                {activity.kind === 'tool'
                  ? t('activity.tool', { tool: toolLabel(t, activity.name) })
                  : t(`activity.${activity.kind}`)}
              </Shimmer>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton aria-label={t('scrollDown')} title={t('scrollDown')} />
      </Conversation>
      {errorAlert}
      <div className="px-2 pb-1">{composer}</div>
    </div>
  );
}
