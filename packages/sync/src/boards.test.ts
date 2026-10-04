import { ForbiddenError } from '@agile/connections';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  discoverBoards,
  listBoards,
  listStatusMappings,
  saveStatusMappings,
  setBoardSelection,
} from './boards';
import { member, owner, startSyncHarness } from './test-harness';

describe('boards and status mapping', () => {
  let h: Awaited<ReturnType<typeof startSyncHarness>>;
  let connectionId = '';
  beforeAll(async () => {
    h = await startSyncHarness();
    connectionId = await h.connect();
  });
  afterAll(async () => h?.stop());

  it('discovers boards, then reads the configuration of the boards selected', async () => {
    const r = await discoverBoards(h.deps, owner(), connectionId);
    expect(r.ok && r.boards.map((b) => [b.name, b.type, b.configured, b.selected])).toEqual([
      ['DEMO Scrum', 'scrum', false, false],
      ['OPS Kanban', 'kanban', false, false],
    ]);
    const ids = (await listBoards(h.deps, 'org_a', connectionId)).map((b) => b.id);
    await setBoardSelection(h.deps, owner(), connectionId, ids);
    expect(
      (await listBoards(h.deps, 'org_a', connectionId)).map((b) => [
        b.name,
        b.usesEstimates,
        b.configured,
        b.selected,
      ]),
    ).toEqual([
      ['DEMO Scrum', true, true, true],
      ['OPS Kanban', false, true, true],
    ]);
  });

  it('suggests a mapping for every column status from Jira categories', async () => {
    const [scrum] = await listBoards(h.deps, 'org_a', connectionId);
    const mappings = await listStatusMappings(h.deps, 'org_a', scrum?.id ?? '');
    expect(mappings.map((m) => [m.statusName, m.category, m.blocked, m.source])).toEqual([
      ['Blocked', 'in_progress', true, 'auto'],
      ['Done', 'done', false, 'auto'],
      ['In Progress', 'in_progress', false, 'auto'],
      ['In Review', 'in_progress', false, 'auto'],
      ['To Do', 'todo', false, 'auto'],
    ]);
  });

  it('saves the user mapping and keeps it when boards are rediscovered', async () => {
    const [scrum] = await listBoards(h.deps, 'org_a', connectionId);
    const boardId = scrum?.id ?? '';
    expect(
      await saveStatusMappings(h.deps, owner(), boardId, [
        { jiraStatusId: '10001', category: 'in_progress', blocked: true }, // In Review = waiting
        { jiraStatusId: '10003', category: 'done', blocked: true }, // blocked only applies in progress
      ]),
    ).toEqual({ ok: true, updated: 2 });
    await discoverBoards(h.deps, owner(), connectionId);
    const byName = Object.fromEntries(
      (await listStatusMappings(h.deps, 'org_a', boardId)).map((m) => [m.statusName, m]),
    );
    expect(byName['In Review']).toMatchObject({ blocked: true, source: 'user' });
    expect(byName.Done).toMatchObject({ category: 'done', blocked: false, source: 'user' });
    expect(
      await saveStatusMappings(h.deps, owner(), boardId, [
        { jiraStatusId: 'nope', category: 'done', blocked: false },
      ]),
    ).toEqual({ ok: false, code: 'not_found' });
  });

  it('selects exactly the given boards of this connection', async () => {
    const boards = await listBoards(h.deps, 'org_a', connectionId);
    const ids = boards.map((b) => b.id);
    const foreign = '00000000-0000-4000-8000-000000000000';
    expect(await setBoardSelection(h.deps, owner(), connectionId, [ids[0] ?? '', foreign])).toEqual(
      {
        ok: true,
        selected: 1,
      },
    );
    expect(await setBoardSelection(h.deps, owner(), connectionId, ids)).toEqual({
      ok: true,
      selected: 2,
    });
    expect((await listBoards(h.deps, 'org_a', connectionId)).every((b) => b.selected)).toBe(true);
  });

  it('is tenant-scoped and limited to owners and admins', async () => {
    expect(await listBoards(h.deps, 'org_b', connectionId)).toEqual([]);
    expect(await setBoardSelection(h.deps, owner('org_b'), connectionId, [])).toEqual({
      ok: false,
      code: 'not_found',
    });
    await expect(discoverBoards(h.deps, member(), connectionId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('reports Jira failures as codes', async () => {
    const other = await h.connect(owner('org_c'), 'Other');
    const broken = { ...h.deps, allowedPrivateHosts: [] }; // 127.0.0.1 is no longer allowed
    expect(await discoverBoards(broken, owner('org_c'), other)).toEqual({
      ok: false,
      code: 'blocked_url',
    });
  });
});
