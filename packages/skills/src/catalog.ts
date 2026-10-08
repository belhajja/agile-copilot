import { type Actor, type Db, skills, withOrg } from '@agile/db';
import { and, eq } from 'drizzle-orm';
import type { SkillDocument } from './document';
import { BUILTIN_SKILLS } from './library';
import { loadSkillsWithDocuments } from './store';

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

/**
 * The actor's own enabled skills with their parsed current version (invalid ones are skipped),
 * and the built-ins they copied, whether that copy is on or off: a copy replaces the stock skill,
 * so turning the copy off never brings the stock one back (P4-R23).
 */
async function ownSkills(db: Db, actor: Actor) {
  const loaded = await withOrg(db, actor.orgId, (tx) =>
    loadSkillsWithDocuments(
      tx,
      and(eq(skills.orgId, actor.orgId), eq(skills.ownerUserId, actor.userId)),
    ),
  );
  const enabled: SkillDocument[] = [];
  const copiedBuiltins = new Set<string>();
  for (const l of loaded) {
    if (l.skill.builtinKey) copiedBuiltins.add(l.skill.builtinKey);
    if (l.skill.enabled && l.parsed.ok) enabled.push(l.parsed.skill);
  }
  return { enabled, copiedBuiltins };
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
export async function loadSkillSet(db: Db, actor: Actor): Promise<SkillSet> {
  const { enabled: own, copiedBuiltins } = await ownSkills(db, actor);
  const preferences = own
    .filter((s) => s.frontmatter.trigger === 'always')
    .slice(0, MAX_PREFERENCES)
    .map((s) => ({ name: s.frontmatter.name, instructions: s.instructions }));
  const usable = own.filter((s) => s.frontmatter.trigger !== 'always');
  const names = new Set(usable.map((s) => s.frontmatter.name));
  const builtins = BUILTIN_SKILLS.filter((b) => !copiedBuiltins.has(b.key) && !names.has(b.key));
  const entries = [
    ...usable.map((skill) => ({ source: 'own' as const, skill })),
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
