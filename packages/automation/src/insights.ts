import { type Actor, type Db, skillRuns, skills, withOrg } from '@agile/db';
import { loadSkillsWithDocuments } from '@agile/skills';
import { and, desc, eq, inArray } from 'drizzle-orm';

export interface Insight {
  skillId: string;
  name: string;
  description: string;
  /** The latest successful report (Markdown written by the model: render it as untrusted). */
  output: string;
  finishedAt: Date | null;
}

/**
 * Insight cards of a board's dashboard: the latest report of each of the actor's OWN enabled
 * skills with the `dashboard_card` output whose scope includes the board (or has no scope).
 * Reports are owner-only (P4-R1): another member's shared skill never produces a card here.
 */
export async function insightsFor(db: Db, actor: Actor, boardId: string): Promise<Insight[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const loaded = await loadSkillsWithDocuments(
      tx,
      and(
        eq(skills.orgId, actor.orgId),
        eq(skills.ownerUserId, actor.userId),
        eq(skills.enabled, true),
        eq(skills.output, 'dashboard_card'),
      ),
    );
    const inScope = loaded.filter((l) => {
      const scope = l.parsed.ok ? l.parsed.skill.frontmatter.scope?.boards : undefined;
      return !scope || scope.includes(boardId);
    });
    if (inScope.length === 0) return [];
    const runs = await tx
      .selectDistinctOn([skillRuns.skillId], {
        skillId: skillRuns.skillId,
        output: skillRuns.output,
        finishedAt: skillRuns.finishedAt,
      })
      .from(skillRuns)
      .where(
        and(
          inArray(
            skillRuns.skillId,
            inScope.map((l) => l.skill.id),
          ),
          eq(skillRuns.status, 'succeeded'),
        ),
      )
      .orderBy(skillRuns.skillId, desc(skillRuns.createdAt));
    const latest = new Map(runs.map((r) => [r.skillId, r]));
    const out: Insight[] = [];
    for (const l of inScope) {
      const run = latest.get(l.skill.id);
      if (run?.output) {
        out.push({
          skillId: l.skill.id,
          name: l.skill.name,
          description: l.skill.description,
          output: run.output,
          finishedAt: run.finishedAt,
        });
      }
    }
    return out;
  });
}
