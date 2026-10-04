import 'server-only';
import type { SkillRunDeps } from '@agile/agent';
import { createSkillQueues } from '@agile/automation';
import type { NotifyDeps } from '@agile/notify';
import type { PgBoss } from 'pg-boss';
import { agentDeps } from './agent';
import { connectionDeps, services } from './context';
import { syncQueue } from './sync';

/** Delivery channels (tests on save, encryption): the connection deps and outbound policy. */
export function notifyDeps(): NotifyDeps {
  return connectionDeps();
}

/**
 * Skill previews and drafts in the web process: the agent's deps, reading Jira through the
 * read-only mcp-atlassian twin only (like the worker's background runs).
 */
export function skillRunDeps(): SkillRunDeps {
  return { ...agentDeps(), mcpAtlassianReadonlyUrl: services().env.MCP_ATLASSIAN_READONLY_URL };
}

const g = globalThis as unknown as { __agileSkillQueue?: Promise<PgBoss> };

/** The job producer for "Run now" (the sync producer, with the skill queues created once). */
export function skillQueue(): Promise<PgBoss> {
  g.__agileSkillQueue ??= syncQueue()
    .then(async (boss) => {
      await createSkillQueues(boss);
      return boss;
    })
    .catch((error: unknown) => {
      g.__agileSkillQueue = undefined; // retry on the next request
      throw error;
    });
  return g.__agileSkillQueue;
}

/** Background runs per workspace and day (shared with the worker's setting). */
export const skillRunsDailyLimit = () => services().env.SKILL_RUNS_DAILY_LIMIT;
