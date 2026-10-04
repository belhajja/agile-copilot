import { randomUUID } from 'node:crypto';
import { loadDefaultLlm } from '@agile/connections';
import { withOrg } from '@agile/db';
import { isJiraWriteTool } from '@agile/jira-tools/catalog';
import { createLanguageModel } from '@agile/llm';
import { createOutboundFetch } from '@agile/net';
import {
  convertToModelMessages,
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
  endTurn,
  heldHistory,
  holdsTurn,
  loadConversation,
  openOrCreateConversation,
  releaseTurn,
  saveConversation,
  TurnInProgressError,
  TurnLostError,
} from './conversations';
import type { AgentActor, AgentDeps } from './deps';
import { jiraSitesData, systemPrompt } from './prompt';
import { AgentToolError, buildAgentTools, canUseLiveJira } from './tools';
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
        text: z.string().trim().min(1).max(8_000),
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

export type AgentErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'no_llm'
  | 'duplicate_message'
  | 'approval_not_found'
  | 'already_decided'
  | 'turn_in_progress';

const STATUS: Record<AgentErrorCode, number> = {
  invalid_request: 400,
  not_found: 404,
  no_llm: 409,
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
  actor: AgentActor,
  body: unknown,
): Promise<Response> {
  const parsed = agentRequestSchema.safeParse(body);
  if (!parsed.success) return fail('invalid_request');
  const req = parsed.data;

  const llm = await loadDefaultLlm(deps, actor.orgId);
  if (!llm) return fail('no_llm');
  // Only a new message may create a conversation; decisions need an existing one.
  const conversation = req.message
    ? await openOrCreateConversation(deps.db, actor, req.conversationId)
    : await loadConversation(deps.db, actor, req.conversationId);
  if (!conversation) return fail('not_found');
  const conversationId = conversation.id;
  const turnId = randomUUID();

  let prepared: UIMessage[];
  try {
    prepared = await withOrg(deps.db, actor.orgId, async (tx) => {
      // The history is read under the lock, after taking the turn lease.
      let messages = await beginTurn(tx, actor, conversationId, turnId);
      // An approved change an earlier turn never ran (or never stored the result of) gets one
      // now: a tool call without a result would make every later model request fail (P3-R26).
      messages = await settleApprovedParts(tx, actor, conversationId, messages);
      if (req.approvals) {
        // A user no longer allowed to change Jira (demoted since the proposal) can only deny it.
        const decisions = canUseLiveJira(actor)
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
      }
      await saveConversation(tx, actor, conversationId, messages);
      return messages;
    });
  } catch (e) {
    const code = refusalOf(e);
    if (code) return fail(code);
    throw e;
  }

  const release = async () => {
    try {
      await releaseTurn(deps.db, actor, conversationId, turnId);
    } catch (e) {
      deps.onError?.(e, 'turn_release_failed');
    }
  };
  // A turn that fails after the decisions were stored: every approved change it did not run (or
  // whose result it could not store) gets a result in the stored history, then the lease ends.
  const settleStored = async () => {
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
  };

  let built: Awaited<ReturnType<typeof buildAgentTools>>;
  try {
    built = await buildAgentTools(deps, actor, conversationId);
  } catch (e) {
    await settleStored();
    await release();
    throw e;
  }
  const { tools, sites, jira, close } = built;
  const now = deps.now ?? (() => new Date());

  let model: ReturnType<NonNullable<AgentDeps['createModel']>>;
  let modelMessages: ModelMessage[];
  try {
    model = (
      deps.createModel ??
      ((config) =>
        createLanguageModel(config, {
          // A user-supplied model URL (OpenAI-compatible) is resolved once and pinned (DNS rebinding).
          fetch: createOutboundFetch({
            allowedPrivateHosts: deps.allowedPrivateHosts,
            resolve: deps.resolve,
          }),
        }))
    )(llm.config);
    modelMessages = await convertToModelMessages(prepared, { tools });
    // Admin-entered site names reach the model as data, never in the system prompt.
    const sitesData = jiraSitesData(sites);
    if (sitesData) modelMessages = [{ role: 'user', content: sitesData }, ...modelMessages];
  } catch (e) {
    await close();
    await settleStored();
    await release();
    throw e;
  }

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
  // Stops a run whose conversation was taken over (it ran past its lease): no more steps or tools.
  const abort = new AbortController();

  try {
    const result = streamText({
      model,
      system: systemPrompt({ now: now(), jiraSites: sites, jira }),
      messages: modelMessages,
      tools,
      toolApproval,
      stopWhen: stepCountIs(deps.maxSteps ?? 8),
      abortSignal: abort.signal,
      onStepEnd: async ({ usage }) => {
        const u = tokenUsageOf(usage);
        used.inputTokens += u.inputTokens;
        used.outputTokens += u.outputTokens;
        used.cachedInputTokens += u.cachedInputTokens;
        try {
          if (!(await holdsTurn(deps.db, actor, conversationId, turnId))) abort.abort();
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

    return result.toUIMessageStreamResponse({
      originalMessages: prepared,
      generateMessageId: randomUUID,
      // The SSE stream is drained on the server whatever the browser does: a closed tab does not
      // cancel it, so `onEnd` runs once, after the model and its tools are done, with every part.
      consumeSseStream: ({ stream }) => drain(stream),
      // Awaited before the response ends: once the browser sees the end of the stream, the reply
      // and its approval requests are stored, so an immediate Approve finds them.
      onEnd: async ({ messages }: { messages: UIMessage[] }) => {
        await meter();
        try {
          await withOrg(deps.db, actor.orgId, async (tx) => {
            await endTurn(tx, actor, conversationId, turnId);
            // An approved change the stream did not run (it failed first, or the SDK refused the
            // input) is closed with a result before the reply is stored (P3-R26).
            const settled = await settleApprovedParts(tx, actor, conversationId, messages);
            await saveConversation(tx, actor, conversationId, settled);
            await recordApprovalRequests(tx, actor, conversationId, settled);
          });
        } catch (e) {
          if (e instanceof TurnLostError) abort.abort();
          deps.onError?.(e, 'persist_failed');
          // The reply is lost, but the stored history still gets a result for every approved change.
          if (!(e instanceof TurnLostError)) await settleStored();
          await release();
          throw e;
        } finally {
          await close();
        }
      },
      onError: safeErrorText,
    });
  } catch (e) {
    abort.abort();
    await close();
    await settleStored();
    await release();
    throw e;
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
