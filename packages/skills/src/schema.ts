import { type MetricKey, type WidgetSpec, widgetSpecSchema } from '@agile/dashboards';
import { z } from 'zod';
import { checkCron, isTimeZone } from './schedule';

export const SKILL_TRIGGERS = ['on_demand', 'always', 'schedule', 'alert'] as const;
export const SKILL_OUTPUTS = ['chat', 'dashboard_card', 'email', 'slack', 'teams'] as const;
export type SkillTrigger = (typeof SKILL_TRIGGERS)[number];
export type SkillOutput = (typeof SKILL_OUTPUTS)[number];

/** Metrics whose widget has a single number (a KPI): the only ones an alert can compare. */
export const ALERT_METRICS: readonly MetricKey[] = widgetSpecSchema.options
  .filter((o) => (o.shape.chart.options as readonly string[]).includes('kpi'))
  .map((o) => o.shape.metric.value);

export const ALERT_OPERATORS = ['>', '>=', '<', '<='] as const;
export type AlertOperator = (typeof ALERT_OPERATORS)[number];

/** No control or bidi-override characters in one-line fields (they render in lists and emails). */
const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !/[\p{Cc}‪-‮⁦-⁩]/u.test(v), 'control characters');

/** 1–64 characters: lowercase letters, digits and inner dashes (Agent Skills naming). */
export const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * An alert condition: a deterministic comparison of one KPI metric with a number, evaluated on
 * each board in scope. Data, not code: the metric and its params go through the widget catalog.
 */
export const alertConditionSchema = z
  .object({
    metric: z.enum(ALERT_METRICS as [MetricKey, ...MetricKey[]]),
    params: z.record(z.string(), z.unknown()).optional(),
    op: z.enum(ALERT_OPERATORS),
    value: z.number().finite().min(-1_000_000).max(1_000_000),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (!alertWidget(a)) ctx.addIssue({ code: 'custom', path: ['params'], message: 'invalid' });
  });

export type AlertCondition = z.output<typeof alertConditionSchema>;

/** The KPI widget an alert reads (params validated and defaulted by the catalog), or null. */
export function alertWidget(a: {
  metric: string;
  params?: Record<string, unknown>;
}): WidgetSpec | null {
  const parsed = widgetSpecSchema.safeParse({
    id: 'alert',
    metric: a.metric,
    chart: 'kpi',
    params: a.params ?? {},
  });
  return parsed.success ? parsed.data : null;
}

/** Whether a KPI value meets the condition. A missing value (no data) never does. */
export function alertMatches(op: AlertOperator, value: number | null, threshold: number): boolean {
  if (value === null || !Number.isFinite(value)) return false;
  switch (op) {
    case '>':
      return value > threshold;
    case '>=':
      return value >= threshold;
    case '<':
      return value < threshold;
    case '<=':
      return value <= threshold;
  }
}

/**
 * The SKILL.md frontmatter (open Agent Skills format plus our trigger/output fields). Unknown keys
 * are refused so a typo never silently changes behaviour.
 */
export const skillFrontmatterSchema = z
  .object({
    name: z.string().regex(SKILL_NAME, 'lowercase letters, digits and dashes'),
    description: oneLine(300),
    scope: z
      .object({ boards: z.array(z.uuid()).min(1).max(20).optional() })
      .strict()
      .optional(),
    trigger: z.enum(SKILL_TRIGGERS).default('on_demand'),
    schedule: z
      .object({ cron: z.string().trim().max(100), timezone: z.string().default('UTC') })
      .strict()
      .optional(),
    alert: alertConditionSchema.optional(),
    output: z.enum(SKILL_OUTPUTS).default('chat'),
  })
  .strict()
  .superRefine((f, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (f.trigger === 'schedule') {
      if (!f.schedule) issue('schedule', 'required');
      else if (!isTimeZone(f.schedule.timezone)) issue('schedule', 'timezone_invalid');
      else {
        const cron = checkCron(f.schedule.cron, f.schedule.timezone);
        if (cron) issue('schedule', cron);
      }
    } else if (f.schedule) issue('schedule', 'only_for_schedule');
    if (f.trigger === 'alert' && !f.alert) issue('alert', 'required');
    if (f.trigger !== 'alert' && f.alert) issue('alert', 'only_for_alert');
    // On-demand skills answer in the chat; preferences shape answers and produce nothing.
    if ((f.trigger === 'on_demand' || f.trigger === 'always') && f.output !== 'chat') {
      issue('output', 'chat_only');
    }
  });

export type SkillFrontmatter = z.output<typeof skillFrontmatterSchema>;
export type SkillFrontmatterInput = z.input<typeof skillFrontmatterSchema>;
