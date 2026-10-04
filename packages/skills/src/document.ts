import { parseDocument, stringify } from 'yaml';
import type { z } from 'zod';
import {
  type SkillFrontmatter,
  type SkillFrontmatterInput,
  skillFrontmatterSchema,
} from './schema';

/** Whole SKILL.md documents are small: a prompt, not a knowledge base. */
export const MAX_DOCUMENT_CHARS = 24_000;
export const MAX_INSTRUCTIONS_CHARS = 20_000;

/** Why a document was refused: a fixed code (translated by the UI) and the field it concerns. */
export type SkillIssueCode =
  | 'too_long'
  | 'missing_frontmatter'
  | 'invalid_yaml'
  | 'empty_instructions'
  | 'required'
  | 'unknown_field'
  | 'timezone_invalid'
  | 'cron_invalid'
  | 'cron_too_frequent'
  | 'only_for_schedule'
  | 'only_for_alert'
  | 'chat_only'
  | 'invalid';

export interface SkillIssue {
  code: SkillIssueCode;
  field?: string;
}

export interface SkillDocument {
  frontmatter: SkillFrontmatter;
  /** The Markdown body: what the model is asked to do. */
  instructions: string;
}

export type ParseResult = { ok: true; skill: SkillDocument } | { ok: false; issues: SkillIssue[] };

const KNOWN = new Set<SkillIssueCode>([
  'required',
  'timezone_invalid',
  'cron_invalid',
  'cron_too_frequent',
  'only_for_schedule',
  'only_for_alert',
  'chat_only',
]);

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

/** The raw value at a zod issue path (a missing value is `required`, a wrong one `invalid`). */
function valueAt(data: unknown, path: readonly PropertyKey[]): unknown {
  let value = data;
  for (const key of path) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value;
}

function issuesOf(error: z.ZodError, data: unknown): SkillIssue[] {
  const out: SkillIssue[] = [];
  for (const i of error.issues) {
    const field = i.path.map(String).join('.') || undefined;
    if (i.code === 'unrecognized_keys') {
      for (const key of i.keys)
        out.push({ code: 'unknown_field', field: field ? `${field}.${key}` : key });
    } else if (i.code === 'invalid_type' && valueAt(data, i.path) === undefined) {
      out.push({ code: 'required', field });
    } else {
      const code = KNOWN.has(i.message as SkillIssueCode)
        ? (i.message as SkillIssueCode)
        : 'invalid';
      out.push({ code, field });
    }
  }
  return out;
}

/**
 * Parses a SKILL.md document: YAML frontmatter between `---` lines, then Markdown instructions.
 * The YAML is read with the core schema, no custom tags and few aliases (no alias bombs).
 */
export function parseSkillDocument(text: string): ParseResult {
  if (text.length > MAX_DOCUMENT_CHARS) return { ok: false, issues: [{ code: 'too_long' }] };
  const match = FRONTMATTER.exec(text.replace(/^\uFEFF/, ''));
  if (!match) return { ok: false, issues: [{ code: 'missing_frontmatter' }] };
  const doc = parseDocument(match[1] ?? '', {
    schema: 'core',
    uniqueKeys: true,
    prettyErrors: false,
    customTags: [],
  });
  if (doc.errors.length > 0) return { ok: false, issues: [{ code: 'invalid_yaml' }] };
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: 10 });
  } catch {
    return { ok: false, issues: [{ code: 'invalid_yaml' }] };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, issues: [{ code: 'invalid_yaml' }] };
  }
  const parsed = skillFrontmatterSchema.safeParse(data);
  const instructions = (match[2] ?? '').trim();
  const issues = parsed.success ? [] : issuesOf(parsed.error, data);
  if (!instructions) issues.push({ code: 'empty_instructions' });
  else if (instructions.length > MAX_INSTRUCTIONS_CHARS) issues.push({ code: 'too_long' });
  if (!parsed.success || issues.length > 0) return { ok: false, issues };
  return { ok: true, skill: { frontmatter: parsed.data, instructions } };
}

/** Writes a skill as SKILL.md (canonical: defaults filled, keys in a fixed order). */
export function serializeSkill(skill: {
  frontmatter: SkillFrontmatterInput;
  instructions: string;
}): string {
  const f = skillFrontmatterSchema.parse(skill.frontmatter);
  const ordered: Record<string, unknown> = { name: f.name, description: f.description };
  if (f.scope?.boards) ordered.scope = { boards: f.scope.boards };
  ordered.trigger = f.trigger;
  if (f.schedule) ordered.schedule = { cron: f.schedule.cron, timezone: f.schedule.timezone };
  if (f.alert) {
    ordered.alert = {
      metric: f.alert.metric,
      ...(f.alert.params && Object.keys(f.alert.params).length > 0
        ? { params: f.alert.params }
        : {}),
      op: f.alert.op,
      value: f.alert.value,
    };
  }
  ordered.output = f.output;
  return `---\n${stringify(ordered, { lineWidth: 0 })}---\n\n${skill.instructions.trim()}\n`;
}
