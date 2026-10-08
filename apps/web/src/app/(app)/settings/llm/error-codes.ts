/**
 * The codes with a sentence under `llm.errors` (not the nested `blocked` group): an LLM
 * connection's stored `lastError` and the form's refusals. A test ties it to the messages.
 */
export const LLM_ERROR_CODES = [
  'invalid_input',
  'blocked_url',
  'insecure_transport',
  'unauthorized',
  'forbidden',
  'model_not_found',
  'rate_limited',
  'no_tool_calling',
  'unreachable',
  'provider_error',
  'not_supported',
  'not_found',
  'forbidden_role',
] as const;
