import { langfuseConfigOf, serverEnv } from '@agile/config';
import { startTracing } from '@agile/observability';
import { flushOnSigterm } from './shutdown';

// Node.js runtime only (imported by instrumentation.ts). serverEnv() is parsed only when tracing
// is configured, so a build or a server without Langfuse never needs it here.
if (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) {
  const config = langfuseConfigOf(serverEnv());
  if (config) {
    const tracing = startTracing(config);
    // Awaited before the process exits (bounded), not fire-and-forget.
    flushOnSigterm(() => tracing.shutdown());
  }
}
