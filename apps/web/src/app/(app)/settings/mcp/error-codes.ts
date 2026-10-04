import type { TokenErrorCode } from '@agile/mcp-gateway';

/**
 * Codes with a sentence under `mcp.errors`: every `TokenError` code of `@agile/mcp-gateway` (the
 * page's access hints and the actions' refusals). A test ties the list to the messages.
 */
export const MCP_ERROR_CODES = [
  'forbidden_role',
  'mcp_disabled',
  'plan_limit',
  'too_many_tokens',
  'invalid_input',
  'not_found',
] as const satisfies readonly TokenErrorCode[];

// Fails to compile when the gateway adds a code this list does not explain.
type Unexplained = Exclude<TokenErrorCode, (typeof MCP_ERROR_CODES)[number]>;
const everyCodeExplained: [Unexplained] extends [never] ? true : never = true;
void everyCodeExplained;
