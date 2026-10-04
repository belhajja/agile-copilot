import { METRIC_KEYS, pinWidget } from '@agile/dashboards';
import type { SkillSet } from '@agile/skills';
import { type ModelMessage, type Tool, type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { AgentActor, AgentDeps } from './deps';
import { AgentToolError } from './tool-errors';
import { asUntrustedData } from './untrusted';

/** A Map that refuses every change (`Object.freeze` does not stop `set`, `delete` or `clear`). */
function frozenMap<K, V>(): ReadonlyMap<K, V> {
  const map = new Map<K, V>();
  const refuse = () => {
    throw new TypeError('This map is read-only.');
  };
  return Object.freeze(Object.assign(map, { set: refuse, delete: refuse, clear: refuse }));
}

/**
 * No catalog, no preferences: what a turn uses when the skills store cannot be read (P4-R6).
 * Shared by every such turn, so it is frozen all the way down.
 */
export const EMPTY_SKILL_SET: SkillSet = Object.freeze({
  catalog: Object.freeze([]) as unknown as SkillSet['catalog'],
  preferences: Object.freeze([]) as unknown as SkillSet['preferences'],
  instructions: frozenMap<string, string>(),
});

/**
 * A skill's instructions for the model. They are user-authored (or built in), so they are
 * instructions, not data, but they stay inside one fixed envelope: `</` is escaped so a skill
 * cannot close it and pose as something else (a data block, the system's rules).
 */
export function asSkillText(
  name: string,
  instructions: string,
  attrs: { trigger?: 'always' } = {},
): string {
  const safeName = name.replace(/[^a-z0-9-]/g, '');
  const trigger = attrs.trigger ? ` trigger="${attrs.trigger}"` : '';
  return `<skill name="${safeName}"${trigger}>\n${instructions.replace(/<\//g, '<\\/')}\n</skill>`;
}

/**
 * What the model is told about skills before the conversation: the catalog (names and
 * descriptions, as data: they only help it choose) and the user's standing preferences.
 */
export function skillContext(set: SkillSet): ModelMessage[] {
  const out: ModelMessage[] = [];
  if (set.catalog.length > 0) {
    out.push({
      role: 'user',
      content: asUntrustedData(
        'skills_catalog',
        set.catalog.map((c) => ({ name: c.name, description: c.description })),
      ),
    });
  }
  const preferences = preferencesMessage(set, 'chat');
  if (preferences) out.push(preferences);
  return out;
}

const PREFERENCES_LEAD = {
  chat: 'My standing preferences (apply them to every answer unless I say otherwise in this chat):',
  run: 'My standing preferences (apply them to this report):',
} as const;

/**
 * The user's standing preferences (their own `always` skills), each in the fixed `<skill>`
 * envelope, as one user message; null when there are none. Shared by chat replies and skill runs.
 */
export function preferencesMessage(set: SkillSet, use: 'chat' | 'run'): ModelMessage | null {
  if (set.preferences.length === 0) return null;
  return {
    role: 'user',
    content: `${PREFERENCES_LEAD[use]}\n${set.preferences
      .map((p) => asSkillText(p.name, p.instructions, { trigger: 'always' }))
      .join('\n')}`,
  };
}

const CHARTS = ['kpi', 'bar', 'line', 'area', 'table'] as const;

/**
 * `load_skill` (progressive disclosure: the full text of one catalog skill, by name) and
 * `pin_widget` (adds a catalog widget to the user's own "Pinned" dashboard of a board). Both are
 * offered to every role: neither touches Jira, and a pin only writes to the caller's dashboard.
 */
export function skillTools(deps: AgentDeps, actor: AgentActor, set: SkillSet): ToolSet {
  const tools: ToolSet = {};
  const names = set.catalog.map((c) => c.name);
  if (names.length > 0) {
    tools.load_skill = tool({
      description:
        'Load the full instructions of a skill from the skills catalog. Call it before doing the task a skill describes, then follow the returned <skill> instructions for that task.',
      inputSchema: z.object({ name: z.enum(names as [string, ...string[]]) }),
      execute: async ({ name }) => {
        const instructions = set.instructions.get(name);
        if (!instructions) throw new AgentToolError('unknown_skill', { tool: 'skill' });
        return asSkillText(name, instructions);
      },
    }) as Tool;
  }
  tools.pin_widget = tool({
    description:
      'Add a chart to the user\'s dashboard of a board (their "Pinned" tab). Only when the user asks to pin or add a chart. Use a board id from list_boards and a metric with one of its charts from list_metrics.',
    inputSchema: z.object({
      boardId: z.string().describe('Board id from list_boards'),
      metric: z.enum(METRIC_KEYS as [string, ...string[]]),
      chart: z.enum(CHARTS),
      title: z.string().max(80).optional().describe('Optional short title'),
      params: z
        .record(z.string(), z.unknown())
        .refine((p) => Object.keys(p).length <= 10, 'at most 10 params')
        .optional()
        .describe('Metric parameters (see list_metrics)'),
    }),
    execute: async ({ boardId, metric, chart, title, params }) => {
      let result: Awaited<ReturnType<typeof pinWidget>>;
      try {
        result = await pinWidget(
          deps.db,
          { orgId: actor.orgId, userId: actor.userId },
          {
            boardId,
            widget: { metric, chart, ...(title ? { title } : {}), params: params ?? {} },
            via: 'assistant',
          },
        );
      } catch (e) {
        // A database error's text (query, parameters) must never reach the model or the history.
        deps.onError?.(e, 'dashboard_unavailable');
        throw new AgentToolError('dashboard_unavailable', { tool: 'dashboard' });
      }
      if (!result.ok) {
        throw new AgentToolError(result.code, {
          tool: 'dashboard',
          data: result.issues
            ? asUntrustedData('pin_widget_error', { invalidFields: result.issues })
            : undefined,
        });
      }
      return asUntrustedData('pin_widget', {
        pinned: true,
        boardId,
        dashboardId: result.dashboardId,
        widget: result.widget,
      });
    },
  }) as Tool;
  return tools;
}
