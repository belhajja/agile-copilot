import type { PgBoss } from 'pg-boss';
import { describe, expect, it } from 'vitest';
import type { AutomationDeps } from './deps';
import { SKILL_RUN_QUEUE, sendSkillRun, startSkillWorker } from './queue';

/** Records what the queue code asks pg-boss for (the behaviour of the options is pg-boss's own,
 * exercised end to end by the sync queue's fairness test, which uses the same mechanism). */
function fakeBoss() {
  const work: { name: string; options: unknown }[] = [];
  const sent: { name: string; data: unknown; options: unknown }[] = [];
  const boss = {
    createQueue: async () => {},
    updateQueue: async () => {},
    schedule: async () => {},
    work: async (name: string, options: unknown) => {
      work.push({ name, options });
      return 'w';
    },
    send: async (name: string, data: unknown, options: unknown) => {
      sent.push({ name, data, options });
      return 'id';
    },
  };
  return { boss: boss as unknown as PgBoss, work, sent };
}

describe('skill runs: one at a time per workspace (F2)', () => {
  it('groups run jobs by workspace and runs one job per group in a worker', async () => {
    const { boss, work } = fakeBoss();
    await startSkillWorker(boss, {} as AutomationDeps);
    expect(work.find((w) => w.name === SKILL_RUN_QUEUE)?.options).toMatchObject({
      batchSize: 1,
      localGroupConcurrency: 1,
    });
  });

  it('sends every run job with its workspace as the group, keyed by run', async () => {
    const { boss, sent } = fakeBoss();
    const runId = '00000000-0000-4000-8000-000000000001';
    await sendSkillRun(boss, { orgId: 'org_a', runId });
    expect(sent).toEqual([
      {
        name: SKILL_RUN_QUEUE,
        data: { orgId: 'org_a', runId },
        options: { singletonKey: runId, group: { id: 'org_a' } },
      },
    ]);
  });
});
