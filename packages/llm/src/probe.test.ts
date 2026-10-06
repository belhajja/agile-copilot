import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BlockedAddressError } from '@agile/net';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { probeModel } from './probe';
import { createLanguageModel } from './providers';
import { startMockOpenAI } from './testing/mock-openai-server';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const toolCallingModel = () =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [
        {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: 'report_status',
          input: '{"status":"ok"}',
        },
      ],
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage,
      warnings: [],
    }),
  });

const failingModel = (error: unknown) =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw error;
    },
  });

const apiError = (statusCode: number, responseBody = '') =>
  new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'https://provider.test',
    requestBodyValues: {},
    statusCode,
    responseBody,
    isRetryable: false,
  });

describe('probeModel', () => {
  it('succeeds when the model calls the tool', async () => {
    expect(await probeModel(toolCallingModel())).toMatchObject({ ok: true });
  });

  it('flags models that answer without calling tools', async () => {
    const textOnly = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage,
        warnings: [],
      }),
    });
    expect(await probeModel(textOnly)).toMatchObject({ ok: false, code: 'no_tool_calling' });
  });

  it('retries with an auto tool choice when a forced call comes back empty', async () => {
    const choices: unknown[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        choices.push(options.toolChoice);
        if (options.toolChoice?.type === 'required') {
          return {
            content: [],
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage,
            warnings: [],
          };
        }
        return toolCallingModel().doGenerate(options);
      },
    });
    expect(await probeModel(model)).toMatchObject({ ok: true });
    expect(choices).toEqual([{ type: 'required' }, { type: 'auto' }]);
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'model_not_found'],
    [429, 'rate_limited'],
    [500, 'provider_error'],
  ])('maps HTTP %i to %s', async (status, code) => {
    expect(await probeModel(failingModel(apiError(status)))).toMatchObject({ ok: false, code });
  });

  it('maps a 400 about tools to no_tool_calling', async () => {
    const e = apiError(400, '{"error":"registry.ollama.ai/library/gemma does not support tools"}');
    expect(await probeModel(failingModel(e))).toMatchObject({ ok: false, code: 'no_tool_calling' });
  });

  it('maps network failures to unreachable', async () => {
    expect(await probeModel(failingModel(new TypeError('fetch failed')))).toMatchObject({
      ok: false,
      code: 'unreachable',
    });
  });

  it('never includes the provider response body in the message', async () => {
    const r = await probeModel(failingModel(apiError(500, 'internal secret-ish detail')));
    expect(r.ok === false && r.message).not.toContain('secret-ish');
  });

  it('reports a blocked (rebound) address as blocked_url, not unreachable', async () => {
    const blocked = new BlockedAddressError('llm.example');
    const wrapped = new APICallError({
      message: 'Cannot connect to API',
      url: 'https://llm.example/v1',
      requestBodyValues: {},
      cause: new TypeError('fetch failed', { cause: blocked }),
      isRetryable: false,
    });
    for (const error of [blocked, new TypeError('fetch failed', { cause: blocked }), wrapped]) {
      expect(await probeModel(failingModel(error))).toMatchObject({
        ok: false,
        code: 'blocked_url',
      });
    }
  });

  it('works end-to-end against an OpenAI-compatible server', async () => {
    const mock = await startMockOpenAI({ validKey: 'good-key' });
    try {
      const good = createLanguageModel({
        provider: 'openai_compatible',
        model: 'mock',
        baseUrl: mock.baseUrl,
        apiKey: 'good-key',
      });
      const bad = createLanguageModel({
        provider: 'openai_compatible',
        model: 'mock',
        baseUrl: mock.baseUrl,
        apiKey: 'bad',
      });
      expect(await probeModel(good)).toMatchObject({ ok: true });
      expect(await probeModel(bad)).toMatchObject({ ok: false, code: 'unauthorized' });
    } finally {
      await mock.close();
    }
  });

  it('accepts a reasoning model that ignores a required tool choice (MiniMax M2)', async () => {
    const mock = await startMockOpenAI({ validKey: 'k', thinking: true });
    try {
      const model = createLanguageModel({
        provider: 'openai_compatible',
        model: 'minimax-m2.5',
        baseUrl: mock.baseUrl,
        apiKey: 'k',
      });
      expect(await probeModel(model)).toMatchObject({ ok: true });
    } finally {
      await mock.close();
    }
  });

  it('does not follow redirects from the provider endpoint', async () => {
    let hits = 0;
    const recorder = createServer((_req, res) => {
      hits++;
      res.end('{}');
    });
    await new Promise<void>((r) => recorder.listen(0, '127.0.0.1', r));
    const recPort = (recorder.address() as AddressInfo).port;
    const redirector = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${recPort}/v1/chat/completions` });
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
    const port = (redirector.address() as AddressInfo).port;
    try {
      const model = createLanguageModel({
        provider: 'openai_compatible',
        model: 'mock',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'k',
      });
      const r = await probeModel(model);
      expect(r).toMatchObject({ ok: false, code: 'unreachable' });
      expect(r.ok === false && r.message).toMatch(/redirected/);
      expect(hits).toBe(0);
    } finally {
      for (const s of [recorder, redirector]) {
        s.close();
        s.closeAllConnections();
      }
    }
  });
});
