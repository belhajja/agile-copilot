import type { Actor } from '@agile/connections';
import type { LlmConfig } from '@agile/llm';
import type { SyncDeps } from '@agile/sync';
import type { LanguageModel } from 'ai';

/** Everything the agent needs from its host (the web app). Tenant comes from `Actor`, never input. */
export interface AgentDeps extends Omit<SyncDeps, 'onError'> {
  /** URL of the shared mcp-atlassian instance (Data Center PAT and Cloud OAuth); unset = none. */
  mcpAtlassianUrl?: string;
  /** Build the model (tests inject a mock). Default: createLanguageModel with DNS pinning. */
  createModel?: (config: LlmConfig) => LanguageModel;
  /** Model steps per reply (tool round-trips). Default 8. */
  maxSteps?: number;
  /** Log hook: only error names and codes, never messages (they can echo provider bodies). */
  onError?: (error: unknown, code: string) => void;
}

export type AgentActor = Pick<Actor, 'orgId' | 'userId' | 'roles'>;
