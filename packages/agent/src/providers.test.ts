import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { type LanguageModel, streamText, type ToolSet } from 'ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentDeps } from './deps';
import { analyticsTools, jiraTools } from './tools';

// Every provider adapter must accept the agent's tool schemas (zod for Jira, MCP JSON Schema for
// analytics). Each adapter's request is captured by a local server that then fails the call: we
// check what would have been sent, not the provider's answer (no API keys here; see the manual
// provider checklist in the README for live runs).
describe('agent tool schemas through every provider adapter', () => {
  const bodies: Record<string, unknown>[] = [];
  let server: Server;
  let base = '';
  let tools: ToolSet;
  let close: () => Promise<void>;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        bodies.push(JSON.parse(raw || '{}'));
        res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"captured"}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const deps = {
      db: {} as AgentDeps['db'],
      keyring: {} as AgentDeps['keyring'],
      allowedPrivateHosts: [],
    };
    const analytics = await analyticsTools(deps as unknown as AgentDeps, {
      orgId: 'o',
      userId: 'u',
      roles: [],
    });
    const sites = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'A',
        deployment: 'cloud' as const,
        authType: 'basic' as const,
        usable: true,
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        name: 'B',
        deployment: 'datacenter' as const,
        authType: 'pat' as const,
        usable: true,
      },
    ];
    tools = {
      ...analytics.tools,
      ...jiraTools(
        deps as unknown as AgentDeps,
        // An owner: write tools are only offered to owners and admins.
        { orgId: 'o', userId: 'u', roles: ['owner'] },
        'c',
        sites,
      ),
    };
    close = analytics.close;
  });
  afterAll(async () => {
    await close?.();
    server?.closeAllConnections();
    await new Promise((r) => server?.close(r));
  });

  const names = () => Object.keys(tools).sort();
  const cases: [string, () => LanguageModel, (body: Record<string, unknown>) => string[]][] = [
    [
      'anthropic',
      () => createAnthropic({ apiKey: 'k', baseURL: `${base}/v1` })('claude-sonnet-5-5'),
      (b) => (b.tools as { name: string }[]).map((t) => t.name),
    ],
    [
      'openai (responses)',
      () => createOpenAI({ apiKey: 'k', baseURL: `${base}/v1` })('gpt-5'),
      (b) => (b.tools as { name: string }[]).map((t) => t.name),
    ],
    [
      'google',
      () => createGoogleGenerativeAI({ apiKey: 'k', baseURL: `${base}/v1beta` })('gemini-2.5-pro'),
      (b) =>
        (b.tools as { functionDeclarations: { name: string }[] }[]).flatMap((t) =>
          t.functionDeclarations.map((f) => f.name),
        ),
    ],
    [
      'mistral',
      () => createMistral({ apiKey: 'k', baseURL: `${base}/v1` })('mistral-large-latest'),
      (b) => (b.tools as { function: { name: string } }[]).map((t) => t.function.name),
    ],
    [
      'azure (openai responses)',
      () => createAzure({ apiKey: 'k', baseURL: `${base}/openai` })('my-deployment'),
      (b) => (b.tools as { name: string }[]).map((t) => t.name),
    ],
    [
      'openai-compatible (Ollama, vLLM…)',
      () => createOpenAICompatible({ name: 'x', baseURL: `${base}/v1` })('llama3.1'),
      (b) => (b.tools as { function: { name: string } }[]).map((t) => t.function.name),
    ],
  ];

  it('declares the 17 agent tools (6 analytics, 11 Jira)', () => {
    expect(names()).toHaveLength(17);
  });

  it.each(cases)('%s receives every tool definition', async (_name, model, toolNames) => {
    bodies.length = 0;
    const result = streamText({ model: model(), tools, prompt: 'hi', maxRetries: 0 });
    await result.consumeStream({ onError: () => {} });
    expect(bodies).toHaveLength(1);
    expect(toolNames(bodies[0] ?? {}).sort()).toEqual(names());
  });
});
