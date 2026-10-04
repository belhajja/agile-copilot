import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { generateText, stepCountIs, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isAllowedAttribute } from './redact';
import { startTracing, type Tracing } from './tracing';

const SECRET_PROMPT =
  'Ana Lopez (ana.lopez@example.com) asks about project NEPTUNE, key sk-live-123';
const SECRET_ARG = 'confidential-board-arg';
const SECRET_RESULT = 'confidential-tool-result';
const SECRET_ANSWER = 'The velocity of NEPTUNE is 42';

const usage = {
  inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
};

/** Step 1 calls a tool, step 2 answers: both carry text we must never export. */
function model() {
  let step = 0;
  return new MockLanguageModelV4({
    modelId: 'mock-model',
    doGenerate: async () => {
      step++;
      return step === 1
        ? {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call-1',
                toolName: 'get_metric',
                input: JSON.stringify({ board: SECRET_ARG }),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
            usage,
            warnings: [],
          }
        : {
            content: [{ type: 'text' as const, text: SECRET_ANSWER }],
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage,
            warnings: [],
          };
    },
  });
}

describe('Langfuse tracing (redacted)', () => {
  const exporter = new InMemorySpanExporter();
  let tracing: Tracing;

  beforeAll(() => {
    tracing = startTracing(
      { publicKey: 'pk-lf-test', secretKey: 'sk-lf-test', baseUrl: 'http://127.0.0.1:9' },
      { exporter },
    );
  });
  afterAll(async () => {
    await tracing?.shutdown();
    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = undefined;
  });

  it('exports model, timings and token counts, and nothing a user or Jira wrote', async () => {
    await generateText({
      model: model(),
      prompt: SECRET_PROMPT,
      tools: {
        get_metric: tool({
          description: 'metric',
          inputSchema: z.object({ board: z.string() }),
          execute: async () => SECRET_RESULT,
        }),
      },
      stopWhen: stepCountIs(3),
      // Worst case: even with recording on, nothing sensitive leaves the process.
      telemetry: { functionId: 'agent-chat', recordInputs: true, recordOutputs: true },
    });
    await new Promise((r) => setTimeout(r, 50));
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThanOrEqual(3);
    const all = JSON.stringify(spans.map((s) => ({ name: s.name, a: s.attributes, e: s.events })));
    for (const secret of [
      'ana.lopez@example.com',
      'Ana Lopez',
      'NEPTUNE',
      'sk-live-123',
      SECRET_ARG,
      SECRET_RESULT,
      SECRET_ANSWER,
    ]) {
      expect(all).not.toContain(secret);
    }
    const attributes = spans.flatMap((s) => Object.keys(s.attributes));
    expect(attributes.every(isAllowedAttribute)).toBe(true);
    // OpenTelemetry GenAI conventions (what Langfuse reads for generations and costs).
    expect(spans.some((s) => s.attributes['gen_ai.request.model'] === 'mock-model')).toBe(true);
    expect(spans.some((s) => s.attributes['gen_ai.tool.name'] === 'get_metric')).toBe(true);
    expect(spans.some((s) => s.attributes['gen_ai.usage.input_tokens'] === 11)).toBe(true);
  });
});

describe('Langfuse tracing scope', () => {
  it('registers no global tracer provider: Next-like spans never reach the exporter', async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = startTracing(
      { publicKey: 'pk-lf-test', secretKey: 'sk-lf-test', baseUrl: 'http://127.0.0.1:9' },
      { exporter },
    );
    try {
      const span = trace
        .getTracer('next.js')
        .startSpan('fetch GET https://acme.atlassian.net/rest/api/3/issue/SECRET-1');
      span.end();
      await new Promise((r) => setTimeout(r, 50));
      expect(exporter.getFinishedSpans()).toEqual([]);
    } finally {
      await tracing.shutdown();
      globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = undefined;
    }
  });
});
