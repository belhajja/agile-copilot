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
} from './approvals';
import {
  beginTurn,
  ConversationNotFoundError,
  endTurn,
  loadConversation,
  openOrCreateConversation,
  releaseTurn,
  saveConversation,
  TurnInProgressError,
} from './conversations';
import type { AgentActor, AgentDeps } from './deps';
import { jiraSitesData, systemPrompt } from './prompt';
import { AgentToolError, buildAgentTools } from './tools';
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
      if (req.approvals) {
        messages = await applyDecisions(tx, actor, conversationId, messages, req.approvals);
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

  let built: Awaited<ReturnType<typeof buildAgentTools>>;
  try {
    built = await buildAgentTools(deps, actor, conversationId);
  } catch (e) {
    await release();
    throw e;
  }
  const { tools, sites, jiraWrites, close } = built;
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
    await release();
    throw e;
  }

  const result = streamText({
    model,
    system: systemPrompt({ now: now(), jiraSites: sites, liveJira: sites.length > 0, jiraWrites }),
    messages: modelMessages,
    tools,
    toolApproval,
    stopWhen: stepCountIs(deps.maxSteps ?? 8),
    onEnd: async ({ totalUsage }) => {
      try {
        await recordUsage(deps.db, actor, {
          conversationId,
          llmConnectionId: llm.id,
          provider: llm.config.provider,
          model: llm.config.model,
          usage: tokenUsageOf(totalUsage),
          prices: llm.prices,
        });
      } catch (e) {
        // Includes CostOverflowError: metering must never fail the turn.
        deps.onError?.(e, 'usage_not_recorded');
      }
    },
    onError: ({ error }) => deps.onError?.(error, 'agent_stream'),
  });
  // Finish (and persist) the reply even if the browser goes away mid-stream.
  result.consumeStream({ onError: () => {} });

  return result.toUIMessageStreamResponse({
    originalMessages: prepared,
    generateMessageId: randomUUID,
    // Awaited before the response ends: once the browser sees the end of the stream, the reply
    // and its approval requests are stored, so an immediate Approve finds them.
    onEnd: async ({ messages }: { messages: UIMessage[] }) => {
      try {
        await withOrg(deps.db, actor.orgId, async (tx) => {
          await endTurn(tx, actor, conversationId, turnId);
          await saveConversation(tx, actor, conversationId, messages);
          await recordApprovalRequests(tx, actor, conversationId, messages);
        });
      } catch (e) {
        deps.onError?.(e, 'persist_failed');
        await release();
        throw e;
      } finally {
        await close();
      }
    },
    onError: safeErrorText,
  });
}
