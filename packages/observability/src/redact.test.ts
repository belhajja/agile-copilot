import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { RedactingSpanProcessor } from './redact';

function setup() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new RedactingSpanProcessor(new SimpleSpanProcessor(exporter))],
  });
  return { exporter, provider };
}

describe('RedactingSpanProcessor', () => {
  it('drops every attribute outside the allowlist, all events and the status message', () => {
    const { exporter, provider } = setup();
    const span = provider.getTracer('ai').startSpan('chat mock-model');
    span.setAttributes({
      'gen_ai.request.model': 'gpt-x',
      'gen_ai.usage.input_tokens': 12,
      'gen_ai.input.messages': '[{"role":"user","content":"ana@example.com wants NEPTUNE"}]',
      'gen_ai.output.messages': 'The answer mentions NEPTUNE',
      'gen_ai.tool.call.arguments': '{"issueKey":"SECRET-1"}',
      'gen_ai.tool.call.result': 'Jira says SECRET',
      'ai.prompt.messages': 'secret prompt',
      'user.id': 'u_123',
      'enduser.id': 'u_123',
    });
    span.recordException(new Error('provider said: invalid key sk-live-999'));
    span.setStatus({ code: 2, message: 'provider said: invalid key sk-live-999' });
    span.end();

    const [exported] = exporter.getFinishedSpans();
    expect(exported?.attributes).toEqual({
      'gen_ai.request.model': 'gpt-x',
      'gen_ai.usage.input_tokens': 12,
    });
    expect(exported?.events).toEqual([]);
    expect(exported?.status).toEqual({ code: 2 });
    expect(JSON.stringify(exported?.attributes)).not.toMatch(/NEPTUNE|SECRET|sk-live|u_123/);
  });

  it('never exports a span from another instrumentation scope (a Next.js HTTP span with a URL)', () => {
    const { exporter, provider } = setup();
    const http = provider
      .getTracer('next.js')
      .startSpan('fetch GET https://acme.atlassian.net/rest/api/3/issue/SECRET-1');
    http.setAttributes({ 'http.url': 'https://acme.atlassian.net/rest/api/3/issue/SECRET-1' });
    http.end();
    provider.getTracer('next.js').startSpan('GET /api/agent/chat').end();
    provider.getTracer('ai').startSpan('ai.generateText').end();

    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(['ai.generateText']);
  });

  it('replaces an AI span name that looks like a URL', () => {
    const { exporter, provider } = setup();
    provider.getTracer('ai').startSpan('chat https://llm.internal.acme.test/v1').end();
    const [exported] = exporter.getFinishedSpans();
    expect(exported?.name).toBe('ai');
  });
});
