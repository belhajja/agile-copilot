/**
 * Next.js server start hook. Optional LLM tracing to Langfuse for the assistant (off unless
 * LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set); spans are redacted before export.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('./instrumentation-node');
}
