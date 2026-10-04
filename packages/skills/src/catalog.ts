import { type Db, skills, withOrg } from '@agile/db';
import { and, eq } from 'drizzle-orm';
import type { SkillDocument } from './document';
import { BUILTIN_SKILLS } from './library';
import { loadSkillsWithDocuments, type SkillActor } from './store';

export interface CatalogEntry {
  name: string;
  description: string;
  /** `own`: written (or copied) by the user; `builtin`: our library. */
  source: 'own' | 'builtin';
}

/** At most this many skills are listed to the model (names and descriptions only). */
export const MAX_CATALOG = 40;
/** At most this many "always" preferences are added to a conversation. */
export const MAX_PREFERENCES = 10;

/** The actor's own enabled skills with their parsed current version (invalid ones are skipped). */
async function ownSkills(db: Db, actor: SkillActor) {
  const loaded = await withOrg(db, actor.orgId, (tx) =>
    loadSkillsWithDocuments(
      tx,
      and(
        eq(skills.orgId, actor.orgId),
        eq(skills.ownerUserId, actor.userId),
        eq(skills.enabled, true),
      ),
    ),
  );
  const out: { builtinKey: string | null; skill: SkillDocument }[] = [];
  for (const l of loaded) {
    if (l.parsed.ok) out.push({ builtinKey: l.skill.builtinKey, skill: l.parsed.skill });
  }
  return out;
}

export interface SkillSet {
  /** What the model may load with `load_skill`. */
  catalog: CatalogEntry[];
  /** The user's "always" preferences, applied to every conversation. */
  preferences: { name: string; instructions: string }[];
  /** The full text behind each catalog entry, by name. */
  instructions: ReadonlyMap<string, string>;
}

/**
 * What one user's assistant knows about skills: their own enabled skills (preferences apart) and
 * the built-in library, minus the built-ins they copied (their copy replaces it). Other members'
 * shared skills are not included: they reach a user's assistant only once that user copies them.
 */
export async function loadSkillSet(db: Db, actor: SkillActor): Promise<SkillSet> {
  const own = await ownSkills(db, actor);
  const preferences = own
    .filter((s) => s.skill.frontmatter.trigger === 'always')
    .slice(0, MAX_PREFERENCES)
    .map((s) => ({ name: s.skill.frontmatter.name, instructions: s.skill.instructions }));
  const usable = own.filter((s) => s.skill.frontmatter.trigger !== 'always');
  const copied = new Set(own.map((s) => s.builtinKey).filter(Boolean));
  const names = new Set(usable.map((s) => s.skill.frontmatter.name));
  const builtins = BUILTIN_SKILLS.filter((b) => !copied.has(b.key) && !names.has(b.key));
  const entries = [
    ...usable.map((s) => ({ source: 'own' as const, skill: s.skill })),
    ...builtins.map((b) => ({ source: 'builtin' as const, skill: b.skill })),
  ].slice(0, MAX_CATALOG);
  return {
    catalog: entries.map((e) => ({
      name: e.skill.frontmatter.name,
      description: e.skill.frontmatter.description,
      source: e.source,
    })),
    preferences,
    instructions: new Map(entries.map((e) => [e.skill.frontmatter.name, e.skill.instructions])),
  };
}
