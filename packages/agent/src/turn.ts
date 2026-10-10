import { randomUUID } from 'node:crypto';
import { loadDefaultLlm, loadUsableLlm } from '@agile/connections';
import { type Actor, withOrg } from '@agile/db';
import { isJiraWriteTool } from '@agile/jira-tools/catalog';
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type ModelMessage,
  stepCountIs,
  streamText,
  type ToolApprovalStatus,
  type UIMessage,
} from 'ai';
import { z } from 'zod';
import {
  ApprovalRequiredError,
  applyDecisions,
  DecisionError,
  pendingApprovalParts,
  recordApprovalRequests,
  settleApprovedParts,
} from './approvals';
import {
  beginTurn,
  ConversationNotFoundError,
  conversationModelId,
  endTurn,
  heldHistory,
  holdsTurn,
  loadConversation,
  openOrCreateConversation,
  releaseTurn,
  saveConversation,
  TurnInProgressError,
  unarchiveConversation,
} from './conversations';
import type { AgentDeps } from './deps';
import { MESSAGE_MAX_LENGTH } from './limits';
import { languageModelFor, usesInsecureTransport } from './model';
import { jiraSitesData, systemPrompt } from './prompt';
import {
  CHAT_MAX_STEPS,
  chatOutputTokens,
  lastStepWithoutTools,
  llmCallLimits,
  replyDeadlineMs,
  timedOut,
  turnLeaseSeconds,
} from './steps';
import { AgentToolError } from './tool-errors';
import { buildAgentTools, canProposeJiraChanges } from './tools';
import { TURN_ERROR_PART, type TurnErrorPart } from './turn-errors';
import { closeUnansweredToolCalls } from './unanswered';
import { recordUsage, tokenUsageOf } from './usage';

/**
 * What the browser may send: the conversation id plus EITHER a new user message OR decisions on
 * pending approvals. Never history, tool inputs or tool outputs: the server owns those.
 */
export const agentRequestSchema = z
  .object({
    conversationId: z.uuid(),
    message: z
      .object({
        id: z.string().regex(/^[\w-]{1,100}$/),
        text: z.string().trim().min(1).max(MESSAGE_MAX_LENGTH),
      })
      .strict()
      .optional(),
    approvals: z
      .array(z.object({ approvalId: z.string().min(1).max(200), approved: z.boolean() }).strict())
      .min(1)
      .max(10)
      .optional(),
  })
  .strict()
  .refine((b) => Boolean(b.message) !== Boolean(b.approvals), 'message xor approvals');

type AgentErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'no_llm'
  | 'insecure_llm'
  | 'duplicate_message'
  | 'approval_not_found'
  | 'already_decided'
  | 'turn_in_progress';

const STATUS: Record<AgentErrorCode, number> = {
  invalid_request: 400,
  not_found: 404,
  no_llm: 409,
  insecure_llm: 409,
  duplicate_message: 409,
  approval_not_found: 409,
  already_decided: 409,
  turn_in_progress: 409,
};
const fail = (code: AgentErrorCode) => Response.json({ error: code }, { status: STATUS[code] });

/** Every Jira write waits for the user; everything else runs directly. */
const toolApproval = ({ toolCall }: { toolCall: { toolName: string } }): ToolApprovalStatus =>
  isJiraWriteTool(toolCall.toolName) ? 'user-approval' : 'not-applicable';

const FAILED_ANSWER =
  'The assistant could not finish this answer. Check the AI provider connection and try again.';

/** Text sent to the browser for a failed step: fixed sentences only (provider bodies can echo keys). */
function safeErrorText(e: unknown): string {
  if (e instanceof AgentToolError || e instanceof ApprovalRequiredError) return e.message;
  return FAILED_ANSWER;
}

class DuplicateMessageError extends Error {
  override name = 'DuplicateMessageError';
}

/** Expected refusals of the prepare step → HTTP error codes; anything else is rethrown. */
function refusalOf(e: unknown): AgentErrorCode | null {
  if (e instanceof DecisionError) return e.code;
  if (e instanceof ConversationNotFoundError) return 'not_found';
  if (e instanceof TurnInProgressError) return 'turn_in_progress';
  if (e instanceof DuplicateMessageError) return 'duplicate_message';
  return null;
}

/**
 * One chat turn: applies the user's message or approval decisions to the stored conversation,
 * runs the model with the tenant's tools, streams the reply (AI SDK UI message stream) and stores
 * the result, the new approval requests and the token usage when the stream ends.
 *
 * Turns of one conversation never overlap: the first takes the conversation's turn lease (under
 * the row lock, before reading the history) and releases it when its reply is stored; a request
 * arriving meanwhile gets 409 `turn_in_progress`.
 */
export async function handleAgentRequest(
  deps: AgentDeps,
  actor: Actor,
  body: unknown,
): Promise<Response> {
  const parsed = agentRequestSchema.safeParse(body);
  if (!parsed.success) return fail('invalid_request');
  const req = parsed.data;

  // The model picked for this conversation, unless it is gone or failing: then the default.
  const picked = await conversationModelId(deps.db, actor, req.conversationId);
  const llm =
    (picked ? await loadUsableLlm(deps, actor.orgId, picked) : null) ??
    (await loadDefaultLlm(deps, actor.orgId));
  if (!llm) return fail('no_llm');
  if (await usesInsecureTransport(deps, llm.config)) return fail('insecure_llm');
  // Only a new message may create a conversation; decisions need an existing one.
  const conversation = req.message
    ? await openOrCreateConversation(deps.db, actor, req.conversationId)
    : await loadConversation(deps.db, actor, req.conversationId);
  if (!conversation) return fail('not_found');
  const conversationId = conversation.id;
  const turnId = randomUUID();
  // The model's budget sets the reply's deadline, and the deadline the turn's lease.
  const maxOutputTokens = chatOutputTokens(llm.maxOutputTokens);
  const timeoutMs = deps.turnTimeoutMs ?? replyDeadlineMs(maxOutputTokens);

  let prepared: UIMessage[];
  try {
    prepared = await withOrg(deps.db, actor.orgId, async (tx) => {
      // The history is read under the lock, after taking the turn lease.
      let messages = await beginTurn(
        tx,
        actor,
        conversationId,
        turnId,
        turnLeaseSeconds(timeoutMs),
      );
      // An approved change an earlier turn never ran (or never stored the result of) gets one
      // now: a tool call without a result would make every later model request fail (P3-R26).
      messages = await settleApprovedParts(tx, actor, conversationId, messages);
      // A reply that stopped mid-step left calls without results: the model APIs refuse them.
      messages = closeUnansweredToolCalls(messages);
      if (req.approvals) {
        // A user no longer allowed to change Jira (demoted since the proposal) can only deny it.
        const decisions = canProposeJiraChanges(actor)
          ? req.approvals
          : req.approvals.map((d) => ({
              ...d,
              approved: false,
              reason: 'forbidden_role' as const,
            }));
        messages = await applyDecisions(tx, actor, conversationId, messages, decisions);
      } else if (req.message) {
        const message = req.message;
        if (messages.some((m) => m.id === message.id)) throw new DuplicateMessageError();
        // A new question while a change waits for approval: the proposal lapses (recorded as rejected).
        const pending = pendingApprovalParts(messages).map((p) => ({
          approvalId: p.approval?.id ?? '',
          approved: false,
          reason: 'superseded' as const,
        }));
        if (pending.length > 0) {
          messages = await applyDecisions(tx, actor, conversationId, messages, pending);
        }
        messages = [
          ...messages,
          { id: message.id, role: 'user', parts: [{ type: 'text', text: message.text }] },
        ];
        await unarchiveConversation(tx, actor, conversationId);
      }
      await saveConversation(tx, actor, conversationId, messages);
      return messages;
    });
  } catch (e) {
    const code = refusalOf(e);
    if (code) return fail(code);
    throw e;
  }

  const turn = new TurnResources(deps, actor, conversationId, turnId);
  try {
    const { tools, sites, jira, skillMessages, close } = await buildAgentTools(
      deps,
      actor,
      conversationId,
    );
    turn.closeWith(close);
    const now = deps.now ?? (() => new Date());
    const model = languageModelFor(deps, llm.config);
    // Admin-entered site names and user-written skills reach the model as messages, never in the
    // system prompt.
    const sitesData = jiraSitesData(sites);
    const modelMessages: ModelMessage[] = [
      ...(sitesData ? [{ role: 'user' as const, content: sitesData }] : []),
      ...skillMessages,
      ...(await convertToModelMessages(prepared, { tools })),
    ];

    // Steps' usage, summed as they end: `totalUsage` is empty when a later step fails.
    const used = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    let metered = false;
    const meter = async () => {
      if (metered) return;
      metered = true;
      try {
        await recordUsage(deps.db, actor, {
          conversationId,
          llmConnectionId: llm.id,
          provider: llm.config.provider,
          model: llm.config.model,
          usage: { ...used },
          prices: llm.prices,
        });
      } catch (e) {
        // Includes CostOverflowError: metering must never fail the turn.
        deps.onError?.(e, 'usage_not_recorded');
      }
    };

    const maxSteps = deps.maxSteps ?? CHAT_MAX_STEPS;
    const limits = llmCallLimits({ maxOutputTokens, timeoutMs, signal: turn.abort.signal });
    const result = streamText({
      model,
      system: systemPrompt({ now: now(), jiraSites: sites, jira }),
      messages: modelMessages,
      tools,
      toolApproval,
      stopWhen: stepCountIs(maxSteps),
      prepareStep: lastStepWithoutTools(maxSteps),
      ...limits,
      // Traced only when a deployment turns Langfuse on; never prompts, messages or tool data.
      telemetry: { functionId: 'agent-chat', recordInputs: false, recordOutputs: false },
      onStepEnd: async ({ usage }) => {
        const u = tokenUsageOf(usage);
        used.inputTokens += u.inputTokens;
        used.outputTokens += u.outputTokens;
        used.cachedInputTokens += u.cachedInputTokens;
        // A turn whose conversation was taken over (it ran past its lease) stops here.
        try {
          if (!(await holdsTurn(deps.db, actor, conversationId, turnId))) turn.abort.abort();
        } catch (e) {
          deps.onError?.(e, 'turn_check_failed');
        }
      },
      onEnd: meter,
      onAbort: meter,
      onError: ({ error }) => deps.onError?.(error, 'agent_stream'),
    });
    // Finish (and persist) the reply even if the browser goes away mid-stream.
    result.consumeStream({ onError: () => {} });

    const reply = createUIMessageStream<UIMessage>({
      originalMessages: prepared,
      generateId: randomUUID,
      execute: async ({ writer }) => {
        let finished = false;
        for await (const chunk of result.toUIMessageStream({ onError: safeErrorText })) {
          if (chunk.type === 'finish') {
            finished = true;
            // Cut off by maxOutputTokens: without a notice the reply just stops, often mid-thought.
            if (chunk.finishReason === 'length') {
              deps.onError?.(new Error('output limit reached'), 'output_limit');
              const notice: TurnErrorPart = {
                type: TURN_ERROR_PART,
                data: { code: 'output_limit' },
              };
              writer.write(notice);
            }
          }
          writer.write(chunk);
        }
        // Stopped by its deadline: the reply (whatever it said so far) ends with a stored notice.
        if (!finished && timedOut(limits.abortSignal)) {
          deps.onError?.(limits.abortSignal.reason, 'turn_timeout');
          const notice: TurnErrorPart = { type: TURN_ERROR_PART, data: { code: 'turn_timeout' } };
          writer.write(notice);
        }
      },
      // Awaited before the response ends: once the browser sees the end of the stream, the reply
      // and its approval requests are stored, so an immediate Approve finds them.
      onEnd: async ({ messages }) => {
        await meter();
        try {
          await withOrg(deps.db, actor.orgId, async (tx) => {
            await endTurn(tx, actor, conversationId, turnId);
            // An approved change the stream did not run (it failed first, or the SDK refused the
            // input) is closed with a result before the reply is stored (P3-R26).
            const settled = closeUnansweredToolCalls(
              await settleApprovedParts(tx, actor, conversationId, messages),
            );
            await saveConversation(tx, actor, conversationId, settled);
            await recordApprovalRequests(tx, actor, conversationId, settled);
          });
        } catch (e) {
          // The reply is lost, but the stored history still gets a result for every approved change.
          await turn.abandon(e, 'persist_failed');
          throw e;
        }
        await turn.close();
      },
      onError: safeErrorText,
    });
    return createUIMessageStreamResponse({
      stream: reply,
      // The SSE stream is drained on the server whatever the browser does: a closed tab does not
      // cancel it, so `onEnd` runs once, after the model and its tools are done, with every part.
      consumeSseStream: ({ stream }) => drain(stream),
    });
  } catch (e) {
    await turn.abandon(e, 'turn_failed');
    throw e;
  }
}

/**
 * What a started turn holds until it ends: the conversation's lease, the abort signal of its model
 * run and, once built, its tools' MCP client. Every way a turn can fail ends through `abandon`.
 */
class TurnResources {
  /** Stops the model and its tools: no more steps or tool calls. */
  readonly abort = new AbortController();
  private closeTools: (() => Promise<void>) | undefined;
  private abandoned = false;

  constructor(
    private readonly deps: AgentDeps,
    private readonly actor: Actor,
    private readonly conversationId: string,
    private readonly turnId: string,
  ) {}

  closeWith(close: () => Promise<void>) {
    this.closeTools = close;
  }

  /** Closes the tools once; never throws. */
  async close() {
    const close = this.closeTools;
    this.closeTools = undefined;
    try {
      await close?.();
    } catch (e) {
      this.deps.onError?.(e, 'mcp_close_failed');
    }
  }

  /**
   * Ends a turn whose reply will not be stored: logs why, stops the model, closes the tools, gives
   * every approved change it did not run (or whose result it could not store) a result in the
   * stored history, then releases the lease. Runs once; never throws.
   */
  async abandon(error: unknown, code: 'turn_failed' | 'persist_failed') {
    if (this.abandoned) return;
    this.abandoned = true;
    this.deps.onError?.(error, code);
    this.abort.abort();
    await this.close();
    await this.settleStored();
    await this.release();
  }

  /** Repairs the stored history only while this turn still holds it (`heldHistory`). */
  private async settleStored() {
    const { deps, actor, conversationId, turnId } = this;
    try {
      await withOrg(deps.db, actor.orgId, async (tx) => {
        const stored = await heldHistory(tx, actor, conversationId, turnId);
        if (!stored) return;
        const before = JSON.stringify(stored);
        const settled = await settleApprovedParts(tx, actor, conversationId, stored);
        if (JSON.stringify(settled) !== before) {
          await saveConversation(tx, actor, conversationId, settled);
        }
      });
    } catch (e) {
      deps.onError?.(e, 'settle_failed');
    }
  }

  private async release() {
    try {
      await releaseTurn(this.deps.db, this.actor, this.conversationId, this.turnId);
    } catch (e) {
      this.deps.onError?.(e, 'turn_release_failed');
    }
  }
}

/** Reads a stream to its end, ignoring its content. */
async function drain(stream: ReadableStream<unknown>): Promise<void> {
  const reader = stream.getReader();
  try {
    while (!(await reader.read()).done) {
      // keep reading
    }
  } catch {
    // The stream's errors are handled where it is produced (onError / onEnd).
  }
}
