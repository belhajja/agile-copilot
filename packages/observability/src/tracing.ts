import { OpenTelemetry } from '@ai-sdk/otel';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { registerTelemetry } from 'ai';
import { AI_SCOPE, RedactingSpanProcessor } from './redact';

export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  /** Self-hosted Langfuse or a Langfuse Cloud region, e.g. https://cloud.langfuse.com */
  baseUrl: string;
  environment?: string;
}

export interface Tracing {
  /** Sends what is buffered (call before the process exits). */
  shutdown(): Promise<void>;
}

/**
 * Optional LLM tracing to Langfuse, off unless configured. Every AI SDK call (chat turns, skill
 * runs, drafts) becomes spans through the AI SDK's OpenTelemetry integration; spans pass through
 * `RedactingSpanProcessor` before the Langfuse exporter, so only model, timings, token counts and
 * tool names leave the process. Media upload is off.
 */
export function startTracing(
  config: LangfuseConfig,
  opts: { exporter?: SpanExporter } = {},
): Tracing {
  const langfuse = new LangfuseSpanProcessor({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
    environment: config.environment,
    mediaUploadEnabled: false,
    exporter: opts.exporter,
    exportMode: opts.exporter ? 'immediate' : 'batched',
  });
  const provider = new NodeTracerProvider({
    spanProcessors: [new RedactingSpanProcessor(langfuse)],
  });
  // No global tracer provider (Next.js route and fetch spans must never reach Langfuse): only the
  // AI SDK gets this provider's tracer. A context manager alone lets model and tool spans nest.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  registerTelemetry(new OpenTelemetry({ tracer: provider.getTracer(AI_SCOPE) }));
  return { shutdown: () => provider.shutdown() };
}
