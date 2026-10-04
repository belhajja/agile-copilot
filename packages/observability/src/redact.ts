import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';

/**
 * The only span attributes that leave the process: model, provider, operation, timings, token
 * counts, finish reasons and tool names. Never prompts, messages, tool arguments or results,
 * response text, provider metadata, user or workspace ids (allowlist: anything new is dropped).
 */
const ALLOWED = new Set([
  'operation.name',
  'ai.operationId',
  'ai.telemetry.functionId',
  'ai.model.id',
  'ai.model.provider',
  'ai.response.finishReason',
  'ai.response.model',
  'ai.response.msToFinish',
  'ai.response.msToFirstChunk',
  'ai.response.avgOutputTokensPerSecond',
  'ai.stream.msToFirstChunk',
  'ai.toolCall.name',
  'gen_ai.agent.name',
  'gen_ai.operation.name',
  'gen_ai.provider.name',
  'gen_ai.system',
  'gen_ai.request.model',
  'gen_ai.request.max_tokens',
  'gen_ai.request.temperature',
  'gen_ai.response.model',
  'gen_ai.response.finish_reasons',
  'gen_ai.output.type',
  'gen_ai.tool.name',
  'gen_ai.tool.type',
  'gen_ai.execute_tool.duration',
  'langfuse.environment',
  'langfuse.release',
]);
const ALLOWED_PREFIXES = ['ai.usage.', 'gen_ai.usage.', 'gen_ai.client.'];

/**
 * The only instrumentation scope that is exported: the tracer `startTracing` hands to the AI SDK.
 * Spans from any other scope (Next.js route and fetch spans, HTTP clients) are never exported.
 */
export const AI_SCOPE = 'ai';

/** A span name that carries a URL (or host) is replaced by the scope name. */
const URL_LIKE = /[a-z][a-z0-9+.-]*:\/\/|\/\//i;

export const isAllowedAttribute = (key: string) =>
  ALLOWED.has(key) || ALLOWED_PREFIXES.some((p) => key.startsWith(p));

/**
 * A copy of an ended span with only allowed attributes, no events (exception events carry error
 * messages, which can echo provider bodies) and no status message.
 */
export function redactSpan(span: ReadableSpan): ReadableSpan {
  const attributes = Object.fromEntries(
    Object.entries(span.attributes).filter(([k]) => isAllowedAttribute(k)),
  );
  return {
    name: URL_LIKE.test(span.name) ? AI_SCOPE : span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    status: { code: span.status.code },
    attributes,
    links: span.links.map((l) => ({ context: l.context })),
    events: [],
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount + span.events.length,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/** Wraps the exporting processor: AI-scope spans only, each redacted before it reaches it. */
export class RedactingSpanProcessor implements SpanProcessor {
  constructor(private readonly inner: SpanProcessor) {}
  onStart(span: Span, parentContext: Context): void {
    if (span.instrumentationScope.name === AI_SCOPE) this.inner.onStart(span, parentContext);
  }
  onEnd(span: ReadableSpan): void {
    if (span.instrumentationScope.name !== AI_SCOPE) return;
    this.inner.onEnd(redactSpan(span));
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}
