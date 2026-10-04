import {
  APICallError,
  generateText,
  type LanguageModel,
  RetryError,
  stepCountIs,
  ToolChoiceViolationError,
  tool,
} from 'ai';
import { z } from 'zod';

export type ProbeFailureCode =
  | 'unauthorized'
  | 'forbidden'
  | 'model_not_found'
  | 'rate_limited'
  | 'no_tool_calling'
  | 'unreachable'
  | 'provider_error';

export type LlmProbeResult =
  | { ok: true; latencyMs: number }
  | { ok: false; code: ProbeFailureCode; message: string };

const fail = (code: ProbeFailureCode, message: string): LlmProbeResult => ({
  ok: false,
  code,
  message,
});

const isRedirectBlocked = (e: unknown) => e instanceof Error && e.name === 'RedirectBlockedError';

function mapLlmError(e: unknown): LlmProbeResult {
  const err = RetryError.isInstance(e) ? e.lastError : e;
  if (
    isRedirectBlocked(err) ||
    isRedirectBlocked((err as { cause?: unknown } | undefined)?.cause)
  ) {
    return fail('unreachable', 'The provider endpoint redirected elsewhere; use its final URL.');
  }
  if (APICallError.isInstance(err)) {
    switch (err.statusCode) {
      case 401:
        return fail('unauthorized', 'The provider rejected this API key.');
      case 403:
        return fail('forbidden', 'This key is not allowed to use this model.');
      case 404:
        return fail(
          'model_not_found',
          'The provider does not know this model (or deployment) name.',
        );
      case 429:
        return fail(
          'rate_limited',
          'The provider is rate limiting this key, or it has no credit left.',
        );
      case 400:
        if (/tool|function/i.test(err.responseBody ?? '')) {
          return fail(
            'no_tool_calling',
            'This model does not support tool calling, which the agent needs.',
          );
        }
        return fail('provider_error', 'The provider rejected the request (HTTP 400).');
      case undefined:
        return fail('unreachable', 'Could not reach the provider.');
      default:
        return fail('provider_error', `The provider returned HTTP ${err.statusCode}.`);
    }
  }
  if (ToolChoiceViolationError.isInstance(err)) {
    return fail(
      'no_tool_calling',
      'The model answered but did not call tools, which the agent needs.',
    );
  }
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return fail('unreachable', 'The provider did not answer in time.');
  }
  if (err instanceof TypeError) return fail('unreachable', 'Could not reach the provider.');
  return fail('provider_error', 'Unexpected error from the provider.');
}

/** Cheap check that a key works AND the model can call tools (the agent depends on it). */
export async function probeModel(
  model: LanguageModel,
  opts: { timeoutMs?: number } = {},
): Promise<LlmProbeResult> {
  const started = performance.now();
  try {
    const result = await generateText({
      model,
      tools: {
        report_status: tool({
          description: 'Report that the connection works.',
          inputSchema: z.object({ status: z.literal('ok') }),
          execute: async ({ status }) => status,
        }),
      },
      toolChoice: 'required',
      stopWhen: stepCountIs(1),
      prompt: 'Call the report_status tool with status "ok".',
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    const called = result.steps.some((s) =>
      s.toolCalls.some((c) => c.toolName === 'report_status'),
    );
    return called
      ? { ok: true, latencyMs: Math.round(performance.now() - started) }
      : fail(
          'no_tool_calling',
          'The model answered but did not call tools, which the agent needs.',
        );
  } catch (e) {
    return mapLlmError(e);
  }
}
