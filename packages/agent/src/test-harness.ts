import { randomUUID } from 'node:crypto';
import { createLlmConnection, setLlmConnectionPrices } from '@agile/connections';
import type { Actor } from '@agile/db';
import { type MockMcpAtlassian, startMockMcpAtlassian } from '@agile/jira-tools/testing';
import { type MockScript, startMockOpenAI } from '@agile/llm/testing';
import { discoverBoards, listBoards, runSync, setBoardSelection } from '@agile/sync';
import { owner, startSyncHarness } from '@agile/sync/testing';
import type { AgentDeps } from './deps';
import { handleAgentRequest } from './turn';

/** Reads an AI SDK UI message stream (SSE) into its chunks. */
async function readChunks(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .map((block) => block.replace(/^data: /, '').trim())
    .filter((data) => data && data !== '[DONE]')
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

export const textOf = (chunks: Record<string, unknown>[]) =>
  chunks
    .filter((c) => c.type === 'text-delta')
    .map((c) => c.delta)
    .join('');

/**
 * Postgres + mock Jira (Data Center) with the demo boards synced, the scripted mock LLM as the
 * workspace's default model (priced 3 / 15 per million tokens), and the mcp-atlassian double.
 */
export async function startAgentHarness(opts: { script?: MockScript } = {}) {
  const h = await startSyncHarness();
  const llm = await startMockOpenAI({ validKey: 'good-key', script: opts.script });
  const mcp: MockMcpAtlassian = await startMockMcpAtlassian({ allowedHosts: ['127.0.0.1'] });
  const connectionId = await h.connect();
  await discoverBoards(h.deps, owner(), connectionId);
  const boards = await listBoards(h.deps, 'org_a', connectionId);
  await setBoardSelection(
    h.deps,
    owner(),
    connectionId,
    boards.map((b) => b.id),
  );
  await runSync(h.deps, { orgId: 'org_a', connectionId, trigger: 'manual' });
  /** Makes the mock LLM the default model of a workspace. */
  const addLlm = async (actor: Actor) => {
    const created = await createLlmConnection(h.deps, actor, {
      label: 'Mock',
      config: {
        provider: 'openai_compatible',
        model: 'mock',
        baseUrl: llm.baseUrl,
        apiKey: 'good-key',
      },
    });
    if (!created.ok) throw new Error(`llm connection failed: ${created.code}`);
    await setLlmConnectionPrices(h.deps, actor, created.connection.id, {
      inputMicros: 3_000_000,
      outputMicros: 15_000_000,
    });
  };
  await addLlm(owner());
  const deps: AgentDeps = { ...h.deps, onError: undefined, mcpAtlassianUrl: mcp.url };
  const sendWith = async (d: AgentDeps, actor: Actor, body: Record<string, unknown>) => {
    const res = await handleAgentRequest(d, actor, body);
    if (res.headers.get('content-type')?.includes('application/json')) {
      return {
        status: res.status,
        error: ((await res.json()) as { error: string }).error,
        chunks: [],
      };
    }
    return { status: res.status, error: null, chunks: await readChunks(res) };
  };
  const send = (actor: Actor, body: Record<string, unknown>) => sendWith(deps, actor, body);
  const ask = (actor: Actor, conversationId: string, text: string) =>
    send(actor, { conversationId, message: { id: randomUUID(), text } });
  return {
    ...h,
    llm,
    mcp,
    deps,
    connectionId,
    addLlm,
    send,
    sendWith,
    ask,
    stop: async () => {
      await mcp.close();
      await llm.close();
      await h.stop();
    },
  };
}
