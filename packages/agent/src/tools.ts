import { createAnalyticsMcpServer } from '@agile/analytics-mcp';
import { assertCanManage, ForbiddenError } from '@agile/connections';
import { jiraConnections, withOrg } from '@agile/db';
import {
  createJiraToolBackend,
  JIRA_TOOL_NAMES,
  JIRA_TOOLS,
  JiraToolError,
  type JiraToolName,
} from '@agile/jira-tools';
import { isJiraWriteTool } from '@agile/jira-tools/catalog';
import { resolveCredentials, SyncError } from '@agile/sync';
import { createMCPClient } from '@ai-sdk/mcp';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type Tool, type ToolSet, tool } from 'ai';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { claimApprovedExecution, type ExecutionResultCode } from './approvals';
import type { AgentActor, AgentDeps } from './deps';
import type { PromptSite } from './prompt';
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
 * What the model and the user see when a tool fails: a fixed sentence with a code. For Jira
 * errors that carry data for the model (e.g. the candidates of an ambiguous assignee), the data
 * follows the sentence, framed by `asUntrustedData`; it is never logged.
 */
export class AgentToolError extends Error {
  override name = 'AgentToolError';
  constructor(
    readonly code: string,
    opts: { tool?: 'jira' | 'analytics'; data?: string } = {},
  ) {
    super(
      `${opts.tool === 'analytics' ? 'The analytics tool failed' : 'The Jira request failed'} (${code}).${opts.data ? `\n${opts.data}` : ''}`,
    );
  }
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
  const close = async () => {
    await client.close();
    await server.close();
  };
  try {
    const discovered = await client.tools();
    const tools: ToolSet = {};
    for (const [name, t] of Object.entries(discovered)) {
      // Re-declared as static tools so results are framed as untrusted data like every other tool.
      tools[name] = tool({
        description: t.description,
        inputSchema: t.inputSchema,
        execute: async (input, options) =>
          frame(name, unwrapMcp(await t.execute(input, options)), 'analytics'),
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
}

/** Connections whose Jira tools can run here (API tokens always; PAT/OAuth need mcp-atlassian). */
async function jiraSites(deps: AgentDeps, actor: AgentActor): Promise<JiraSite[]> {
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
  return rows.filter((r) => r.authType === 'basic' || Boolean(deps.mcpAtlassianUrl));
}

/** Jira changes are for workspace owners and admins (P3-R5); members get the read tools. */
export function canWriteJira(actor: AgentActor): boolean {
  try {
    assertCanManage(actor);
    return true;
  } catch (e) {
    if (e instanceof ForbiddenError) return false;
    throw e;
  }
}

const WRITE_DONE_UNREADABLE = 'The change was made in Jira; its result could not be shown.';

/** The stored outcome of a failed Jira call (kept in step with `ExecutionResultCode`). */
const codeOf = (e: unknown): ExecutionResultCode =>
  e instanceof JiraToolError || e instanceof SyncError ? e.code : 'jira_error';

export function jiraTools(
  deps: AgentDeps,
  actor: AgentActor,
  conversationId: string,
  sites: JiraSite[],
): ToolSet {
  const first = sites[0];
  if (!first) return {};
  const writes = canWriteJira(actor);
  const siteIds = sites.map((s) => s.id) as [string, ...string[]];
  const tools: ToolSet = {};
  for (const name of JIRA_TOOL_NAMES) {
    const write = isJiraWriteTool(name);
    if (write && !writes) continue;
    const def = JIRA_TOOLS[name];
    // With several sites the model picks one from the server's list (an enum): never a free id.
    const inputSchema =
      sites.length > 1
        ? def.input.extend({ site: z.enum(siteIds).describe('Jira site id (see system prompt)') })
        : def.input;
    tools[name] = tool({
      description: def.description,
      inputSchema: inputSchema as z.ZodType<Record<string, unknown>>,
      execute: async (input, { toolCallId, abortSignal }) => {
        const { site, ...args } = input as { site?: string } & Record<string, unknown>;
        // Defence in depth: the role is re-checked even though members never get write tools.
        if (write && !canWriteJira(actor)) throw new AgentToolError('forbidden');
        const target = sites.find((s) => s.id === (site ?? first.id));
        if (!target) throw new AgentToolError('not_found');
        const gate = write
          ? await claimApprovedExecution(deps.db, actor, {
              conversationId,
              toolCallId,
              toolName: name,
              input,
            })
          : null;
        let out: unknown;
        try {
          const creds = await resolveCredentials(deps, actor.orgId, target.id);
          const backend = createJiraToolBackend(creds, {
            mcpAtlassianUrl: deps.mcpAtlassianUrl,
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

/** All tools of one reply, plus what the system prompt says about Jira. */
export async function buildAgentTools(deps: AgentDeps, actor: AgentActor, conversationId: string) {
  const analytics = await analyticsTools(deps, actor);
  try {
    const sites = await jiraSites(deps, actor);
    return {
      tools: { ...analytics.tools, ...jiraTools(deps, actor, conversationId, sites) },
      sites: sites.map(({ id, name, deployment }) => ({ id, name, deployment })),
      jiraWrites: canWriteJira(actor),
      close: analytics.close,
    };
  } catch (e) {
    await analytics.close();
    throw e;
  }
}
