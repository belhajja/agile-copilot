import {
  ALERT_METRICS,
  ALERT_OPERATORS,
  SKILL_OUTPUTS,
  SKILL_TRIGGERS,
  serializeSkill,
} from '@agile/skills';
import { z } from 'zod';

/** What the builder's model fills in: flat fields (every provider's tool schema accepts them). */
export const draftSchema = z.object({
  name: z.string().describe('Short lowercase name with dashes, e.g. monday-risks'),
  description: z.string().describe('One line: what the skill does'),
  trigger: z.enum(SKILL_TRIGGERS).describe('When it runs'),
  cron: z
    .string()
    .optional()
    .describe('trigger "schedule": 5-field cron, at most hourly, e.g. "0 8 * * 1"'),
  timezone: z.string().optional().describe('trigger "schedule": IANA time zone, e.g. Europe/Paris'),
  alertMetric: z.enum(ALERT_METRICS as [string, ...string[]]).optional(),
  alertOp: z.enum(ALERT_OPERATORS).optional(),
  alertValue: z.number().optional(),
  output: z.enum(SKILL_OUTPUTS).describe('Where the result goes'),
  instructions: z.string().describe('Markdown steps for the analysis, naming the tools to call'),
});

export type SkillDraft = z.output<typeof draftSchema>;

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '') || 'my-skill';

/**
 * The model's proposal as a SKILL.md document, built and validated by `serializeSkill` (the
 * skills schema). An invalid trigger/output combination falls back to an on-demand chat skill;
 * null when even that is invalid.
 */
export function draftToDocument(
  d: SkillDraft,
  /** Told when a form is refused (code `skill_draft_fallback`); log the error name only. */
  onError?: (error: unknown, code: string) => void,
): string | null {
  const base = {
    name: slug(d.name),
    description: d.description.replace(/\s+/g, ' ').trim().slice(0, 300) || 'Custom skill',
  };
  const instructions = d.instructions.trim().slice(0, 20_000);
  const attempts = [
    {
      ...base,
      trigger: d.trigger,
      output: d.output,
      ...(d.trigger === 'schedule' && d.cron
        ? { schedule: { cron: d.cron, timezone: d.timezone || 'UTC' } }
        : {}),
      ...(d.trigger === 'alert' && d.alertMetric && d.alertOp && d.alertValue !== undefined
        ? { alert: { metric: d.alertMetric, op: d.alertOp, value: d.alertValue } }
        : {}),
    },
    { ...base, trigger: 'on_demand' as const, output: 'chat' as const },
  ];
  for (const frontmatter of attempts) {
    try {
      return serializeSkill({ frontmatter: frontmatter as never, instructions });
    } catch (e) {
      // Visible in the logs; then the next, simpler form.
      onError?.(e, 'skill_draft_fallback');
    }
  }
  return null;
}
