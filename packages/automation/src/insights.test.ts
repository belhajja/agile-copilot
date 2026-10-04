import { jiraBoards, skills, withOrg } from '@agile/db';
import { createSkill, serializeSkill, setSkillVisibility } from '@agile/skills';
import { member, owner } from '@agile/sync/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeSkillRun } from './execute';
import { insightsFor } from './insights';
import { createRun } from './runs';
import { startAutomationHarness } from './test-harness';

describe('dashboard insight cards', () => {
  let h: Awaited<ReturnType<typeof startAutomationHarness>>;
  let scrum = '';
  let kanban = '';
  beforeAll(async () => {
    h = await startAutomationHarness();
    const boards = await h.rawDb
      .select({ id: jiraBoards.id, name: jiraBoards.name })
      .from(jiraBoards);
    scrum = boards.find((b) => b.name === 'DEMO Scrum')?.id ?? '';
    kanban = boards.find((b) => b.name === 'OPS Kanban')?.id ?? '';
  });
  afterAll(async () => h?.stop());

  const cardSkill = async (name: string, scope?: string[]) => {
    const r = await createSkill(h.db, owner(), {
      document: serializeSkill({
        frontmatter: {
          name,
          description: `About ${name}`,
          trigger: 'schedule',
          schedule: { cron: '0 8 * * 1' },
          output: 'dashboard_card',
          ...(scope ? { scope: { boards: scope } } : {}),
        },
        instructions: 'Report.',
      }),
      now: new Date(),
    });
    if (!r.ok) throw new Error(r.code);
    const run = await withOrg(h.db, 'org_a', (tx) =>
      createRun(tx, 'org_a', {
        skillId: r.id,
        version: 1,
        trigger: 'manual',
        now: new Date(),
        dailyLimit: 50,
      }),
    );
    await executeSkillRun(h.deps, 'org_a', run?.id ?? '');
    return r.id;
  };

  it("shows the latest report of the user's card skills whose scope includes the board", async () => {
    await cardSkill('everywhere');
    await cardSkill('scrum-only', [scrum]);
    expect((await insightsFor(h.db, owner(), scrum)).map((i) => [i.name, i.output])).toEqual([
      ['everywhere', 'Report for everywhere: 2 boards checked.'],
      ['scrum-only', 'Report for scrum-only: 2 boards checked.'],
    ]);
    expect((await insightsFor(h.db, owner(), kanban)).map((i) => i.name)).toEqual(['everywhere']);
    // Another member sees their own cards only.
    expect(await insightsFor(h.db, member(), scrum)).toEqual([]);
    // A skill turned off disappears.
    await h.rawDb.update(skills).set({ enabled: false }).where(eq(skills.name, 'everywhere'));
    expect((await insightsFor(h.db, owner(), kanban)).map((i) => i.name)).toEqual([]);
  });

  it('never shows a shared skill report to another member (P4-R1)', async () => {
    const id = await cardSkill('shared-card');
    await h.rawDb.update(skills).set({ enabled: true }).where(eq(skills.id, id));
    await setSkillVisibility(h.db, owner(), id, 'workspace');
    expect((await insightsFor(h.db, member(), scrum)).map((i) => i.name)).toEqual([]);
    expect((await insightsFor(h.db, owner(), scrum)).map((i) => i.name)).toContain('shared-card');
  });
});
