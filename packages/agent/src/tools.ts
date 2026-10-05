import { createAnalyticsMcpServer } from '@agile/analytics-mcp';
import { can } from '@agile/auth';
import { jiraConnections, withOrg } from '@agile/db';
import {
  createJiraToolBackend,
  JIRA_TOOL_NAMES,
  JIRA_TOOLS,
  JiraToolError,
  type JiraToolName,
} from '@agile/jira-tools';
import { isJiraMcpOnlyTool, isJiraWriteTool } from '@agile/jira-tools/catalog';
import { loadSkillSet, type SkillSet } from '@agile/skills';
import { resolveCredentials, SyncError } from '@agile/sync';
import { createMCPClient } from '@ai-sdk/mcp';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type Tool, type ToolSet, tool } from 'ai';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  ApprovalRequiredError,
  claimApprovedExecution,
  type ExecutionResultCode,
  refuseApprovedExecution,
  WRITE_DONE_UNREADABLE,
} from './approvals';
import type { AgentActor, AgentDeps } from './deps';
import type { JiraAccess, PromptSite } from './prompt';
import { EMPTY_SKILL_SET, skillContext, skillTools } from './skills';
import {
  AgentToolError,
  ANALYTICS_ERROR_CODES,
  type AnalyticsErrorCode,
  CREDENTIAL_ERROR_CODES,
  type CredentialErrorCode,
} from './tool-errors';
import { asUntrustedData, UntrustedDataError } from './untrusted';

/** MCP tool results → plain JSON (the text content the analytics server writes). */
function unwrapMcp(result: unknown): unknown {
  const content = (result as { content?: { type: string; text?: string }[] } | null)?.content;
  const text = content?.find((c) => c.type === 'text')?.text;
  if (text === undefined) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The code of a failed analytics call. `@ai-sdk/mcp` returns `isError` results instead of
 * throwing; the server names the code, and the MCP SDK's own input validation reads as invalid
 * params.
 */
function analyticsCodeOf(payload: unknown): AnalyticsErrorCode {
  const code = (payload as { code?: unknown } | null)?.code;
  if ((ANALYTICS_ERROR_CODES as readonly unknown[]).includes(code)) {
    return code as AnalyticsErrorCode;
  }
  return typeof payload === 'string' && /-32602|validation/i.test(payload)
    ? 'invalid_params'
    : 'internal_error';
}

/** A tool result framed as untrusted data, or a fixed tool error when it cannot be serialised. */
function frame(name: string, value: unknown, kind: 'jira' | 'analytics'): string {
  try {
    return asUntrustedData(name, value);
  } catch (e) {
    if (e instanceof UntrustedDataError) throw new AgentToolError(e.code, { tool: kind });
    throw e;
  }
}

/**
 * The analytics MCP server, in process: bound to the actor's workspace on the server, reached
 * through the AI SDK MCP client over a linked in-memory transport (no network, no port).
 */
export async function analyticsTools(deps: AgentDeps, actor: AgentActor) {
  const server = createAnalyticsMcpServer(
    { db: deps.db, orgId: actor.orgId, now: deps.now ?? (() => new Date()) },
    { onError: (e, code) => deps.onError?.(e, code) },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = await createMCPClient({ transport: clientTransport });
  // Never throws: a failing close is logged by code, and never hides the turn's own outcome.
  const close = async () => {
    const results = await Promise.allSettled([client.close(), server.close()]);
    for (const r of results) {
      if (r.status === 'rejected') deps.onError?.(r.reason, 'mcp_close_failed');
    }
  };
  try {
    const discovered = await client.tools();
    const tools: ToolSet = {};
    for (const [name, t] of Object.entries(discovered)) {
      // Re-declared as static tools so results are framed as untrusted data like every other tool.
      tools[name] = tool({
        description: t.description,
        inputSchema: t.inputSchema,
        execute: async (input, options) => {
          const result = await t.execute(input, options);
          const payload = unwrapMcp(result);
          if ((result as { isError?: unknown } | null)?.isError === true) {
            // A failure is an error the UI shows as one, never "done" with an error inside.
            throw new AgentToolError(analyticsCodeOf(payload), {
              tool: 'analytics',
              data: frame(`${name}_error`, payload, 'analytics'),
            });
          }
          return frame(name, payload, 'analytics');
        },
      }) as Tool;
    }
    return { tools, close };
  } catch (e) {
    await close();
    throw e;
  }
}

export interface JiraSite extends PromptSite {
  authType: 'basic' | 'oauth' | 'pat';
  /** Its Jira tools can run here (API tokens always; PAT/OAuth need mcp-atlassian). */
  usable: boolean;
}

/**
 * The workspace's Jira connections, oldest first, each marked usable or not: API tokens always
 * (built-in REST backend), PAT/OAuth only when `mcpUrl` names an mcp-atlassian instance.
 */
export async function jiraSites(
  deps: AgentDeps,
  actor: AgentActor,
  mcpUrl: string | undefined,
): Promise<JiraSite[]> {
  const rows = await withOrg(deps.db, actor.orgId, (tx) =>
    tx
      .select({
        id: jiraConnections.id,
        name: jiraConnections.name,
        deployment: jiraConnections.deployment,
        authType: jiraConnections.authType,
      })
      .from(jiraConnections)
      .where(eq(jiraConnections.orgId, actor.orgId))
      .orderBy(asc(jiraConnections.createdAt)),
  );
  return rows.map((r) => ({
    ...r,
    usable: r.authType === 'basic' || Boolean(mcpUrl),
  }));
}

/**
 * Live Jira reads (`jira.read`: owners, admins, managers). They run with the connection's Jira
 * credentials, which can reach beyond the boards an admin selected, so the role is granted
 * explicitly; viewers get the analytics tools (synced, selected boards) only.
 */
export function canUseLiveJira(actor: AgentActor): boolean {
  return can(actor.roles, 'jira.read');
}

/** Proposing Jira changes (`jira.write`); each proposal still waits for the user's approval. */
export function canProposeJiraChanges(actor: AgentActor): boolean {
  return can(actor.roles, 'jira.write');
}

/** The stored outcome of a failed Jira call (one of `ExecutionResultCode`). */
export const codeOf = (e: unknown): Exclude<ExecutionResultCode, 'ok'> => {
  if (e instanceof JiraToolError) return e.code;
  if (e instanceof SyncError && (CREDENTIAL_ERROR_CODES as readonly string[]).includes(e.code)) {
    return e.code as CredentialErrorCode;
  }
  return 'jira_error';
};

/**
 * How the Jira tools are built: for a chat reply (reads, and writes behind the user's approval,
 * bound to the conversation) or read-only for a skill run, where nobody can approve anything and
 * no write tool exists at all. `mcpUrl` is the mcp-atlassian instance the tools call: the
 * read-write one for the chat, the read-only twin for runs.
 */
export type JiraToolMode =
  | { readOnly: false; mcpUrl: string | undefined; conversationId: string }
  | { readOnly: true; mcpUrl: string | undefined };

/**
 * The Jira tools, bound to the actor's workspace on the server. Every call names its site
 * (P3-R24): with several sites the model picks one from the server's list (an enum, never a free
 * id); with one, the server adds it to the input before it is proposed, hashed and approved, and
 * the model never sees the field. A call runs against exactly that connection, or fails
 * (`not_found` when it is gone, `unavailable` when its tools cannot run here): never another one.
 * Roles with `jira.read` get the read tools, `jira.write` the writes (owners, admins, managers);
 * in read-only mode, write tools are never built.
 */
export function buildJiraToolSet(
  deps: AgentDeps,
  actor: AgentActor,
  sites: JiraSite[],
  mode: JiraToolMode,
): ToolSet {
  const offered = sites.filter((s) => s.usable);
  const [first] = offered;
  if (!first || !canUseLiveJira(actor)) return {};
  const allowed = (write: boolean) =>
    write ? canProposeJiraChanges(actor) : canUseLiveJira(actor);
  const tools: ToolSet = {};
  for (const name of JIRA_TOOL_NAMES) {
    const write = isJiraWriteTool(name);
    if (write && mode.readOnly) continue;
    if (!allowed(write)) continue;
    // Composite tools only mcp-atlassian runs: offered with the sites that use it, if any.
    const eligible = isJiraMcpOnlyTool(name)
      ? offered.filter((s) => s.authType !== 'basic')
      : offered;
    const [firstEligible] = eligible;
    if (!firstEligible) continue;
    const eligibleIds = eligible.map((s) => s.id) as [string, ...string[]];
    const def = JIRA_TOOLS[name];
    const inputSchema =
      offered.length > 1
        ? def.input.extend({
            site: z.enum(eligibleIds).describe('Jira site id (see system prompt)'),
          })
        : def.input.transform((i) => ({ ...i, site: firstEligible.id }));
    tools[name] = tool({
      description: def.description,
      inputSchema: inputSchema as unknown as z.ZodType<Record<string, unknown>>,
      execute: async (input, { toolCallId, abortSignal }) => {
        const { site, ...args } = input as { site?: string } & Record<string, unknown>;
        const call = mode.readOnly
          ? null
          : { conversationId: mode.conversationId, toolCallId, toolName: name, input };
        // Refused before anything is sent; an approved write is closed, never left armed (M1).
        const refuse = async (code: 'forbidden_role' | 'not_found' | 'unavailable') => {
          if (write && call) {
            try {
              await refuseApprovedExecution(deps.db, actor, call, code);
            } catch (e) {
              deps.onError?.(e, 'approval_finish_failed');
            }
          }
          return new AgentToolError(code);
        };
        // Defence in depth: the role is re-checked even though viewers never get these tools.
        if (!allowed(write)) throw await refuse('forbidden_role');
        const target = sites.find((s) => s.id === site);
        if (!target) throw await refuse('not_found');
        if (!target.usable) throw await refuse('unavailable');
        if (isJiraMcpOnlyTool(name) && target.authType === 'basic') {
          throw new AgentToolError('not_supported');
        }
        let gate: Awaited<ReturnType<typeof claimApprovedExecution>> | null = null;
        if (write) {
          // Unreachable without a conversation: read-only mode builds no write tool.
          if (!call) throw new AgentToolError('approval_required');
          try {
            gate = await claimApprovedExecution(deps.db, actor, call);
          } catch (e) {
            if (e instanceof ApprovalRequiredError) throw new AgentToolError('approval_required');
            // A database error's text (query, parameters) must never reach the model (M2).
            deps.onError?.(e, 'approval_claim_failed');
            throw new AgentToolError('jira_error');
          }
        }
        let out: unknown;
        try {
          const creds = await resolveCredentials(deps, actor.orgId, target.id);
          const backend = createJiraToolBackend(creds, {
            mcpAtlassianUrl: mode.mcpUrl,
            outbound: { allowedPrivateHosts: deps.allowedPrivateHosts, resolve: deps.resolve },
          });
          if (!backend) throw new JiraToolError('unavailable');
          out = await backend.call(name as JiraToolName, args as never, { signal: abortSignal });
        } catch (e) {
          const code = codeOf(e);
          try {
            await gate?.finish(code);
          } catch (finishError) {
            deps.onError?.(finishError, 'approval_finish_failed');
          }
          deps.onError?.(e, code);
          throw new AgentToolError(code, {
            data:
              e instanceof JiraToolError ? frame(`${name}_error`, e.toData(), 'jira') : undefined,
          });
        }
        // Framed before the outcome is stored: a write that happened is never reported as failed.
        let framed: string;
        try {
          framed = frame(name, out, 'jira');
        } catch (e) {
          if (!gate) throw e;
          deps.onError?.(e, 'unserializable');
          framed = asUntrustedData(name, { ok: true, note: WRITE_DONE_UNREADABLE });
        }
        try {
          await gate?.finish('ok');
        } catch (finishError) {
          // The write happened: report it to the model; only the stored outcome is missing.
          deps.onError?.(finishError, 'approval_finish_failed');
        }
        return framed;
      },
    }) as Tool;
  }
  return tools;
}

/** What the system prompt says about live Jira for this user. */
export function jiraAccessOf(actor: AgentActor, hasUsableSite: boolean): JiraAccess {
  if (!hasUsableSite) return 'unavailable';
  if (!canUseLiveJira(actor)) return 'forbidden_role';
  return canProposeJiraChanges(actor) ? 'full' : 'read_only';
}

/** The chat's Jira tools: reads, and writes behind approval, through the read-write instance. */
export function jiraTools(
  deps: AgentDeps,
  actor: AgentActor,
  conversationId: string,
  sites: JiraSite[],
): ToolSet {
  return buildJiraToolSet(deps, actor, sites, {
    readOnly: false,
    mcpUrl: deps.mcpAtlassianUrl,
    conversationId,
  });
}

/**
 * The user's skill set, or none when the skills store cannot be read: a skills failure must
 * never break the chat, nor an approvals turn (P4-R6, P3-R26). Logged by code (and error name).
 */
async function skillSetOrEmpty(deps: AgentDeps, actor: AgentActor): Promise<SkillSet> {
  try {
    return await loadSkillSet(deps.db, actor);
  } catch (e) {
    deps.onError?.(e, 'skills_unavailable');
    return EMPTY_SKILL_SET;
  }
}

/**
 * The live Jira side of a reply or a run: its tools, the sites the model may name (none when it has
 * no Jira tools) and what the system prompt says about Jira.
 */
export async function liveJira(deps: AgentDeps, actor: AgentActor, mode: JiraToolMode) {
  const sites = await jiraSites(deps, actor, mode.mcpUrl);
  const tools = buildJiraToolSet(deps, actor, sites, mode);
  const offered = sites.filter((s) => s.usable);
  return {
    tools,
    sites:
      Object.keys(tools).length > 0
        ? offered.map(({ id, name, deployment }): PromptSite => ({ id, name, deployment }))
        : [],
    access: jiraAccessOf(actor, offered.length > 0),
  };
}

/** All tools of one reply, plus what the system prompt says about Jira and skills. */
export async function buildAgentTools(deps: AgentDeps, actor: AgentActor, conversationId: string) {
  const analytics = await analyticsTools(deps, actor);
  try {
    const jira = await liveJira(deps, actor, {
      readOnly: false,
      mcpUrl: deps.mcpAtlassianUrl,
      conversationId,
    });
    const skills = await skillSetOrEmpty(deps, actor);
    return {
      tools: { ...analytics.tools, ...jira.tools, ...skillTools(deps, actor, skills) },
      /** The sites the model may name (none when it has no Jira tools). */
      sites: jira.sites,
      jira: jira.access,
      /** Skills catalog and standing preferences, as messages before the conversation. */
      skillMessages: skillContext(skills),
      close: analytics.close,
    };
  } catch (e) {
    await analytics.close();
    throw e;
  }
}
