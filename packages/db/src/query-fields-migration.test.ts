import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { migrationsFolder, runMigrations } from './migrate';
import { startTestDatabase, type TestDatabase } from './testing';

const LAST_BEFORE = '0036_final_conversation_management';

/**
 * Rows synced before 0037 stay valid. The migrator has no "up to" option, so the database is
 * first migrated from a copy of the folder whose journal stops at 0036; migrating again from the
 * real folder then applies 0037 alone (drizzle runs the entries newer than the last applied one).
 */
describe('0037 query fields on existing rows', () => {
  let tdb: TestDatabase;
  let owner: ReturnType<typeof createDb>;
  let before: string;

  beforeAll(async () => {
    before = mkdtempSync(join(tmpdir(), 'migrations-'));
    cpSync(migrationsFolder, before, { recursive: true });
    const journalPath = join(before, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const last = journal.entries.findIndex((e) => e.tag === LAST_BEFORE);
    journal.entries = journal.entries.slice(0, last + 1);
    writeFileSync(journalPath, JSON.stringify(journal));

    tdb = await startTestDatabase({ migrationsFolder: before });
    owner = createDb(tdb.ownerUrl, { max: 1 });
    await owner.db.execute(sql`
      insert into jira_connections (id, org_id, name, deployment, auth_type, base_url, secret, created_by)
      values ('00000000-0000-4000-8000-000000000001', 'o1', 'Jira', 'datacenter', 'pat',
              'https://jira.example.com', 'x', 'u1')`);
    await owner.db.execute(sql`
      insert into jira_boards (org_id, connection_id, jira_board_id, name, type, selected, last_full_sync_at)
      values ('o1', '00000000-0000-4000-8000-000000000001', 1, 'Board', 'scrum', true, now())`);
    await owner.db.execute(sql`
      insert into jira_issues (org_id, connection_id, jira_issue_id, key, summary, issue_type,
                               status_id, jira_created_at, jira_updated_at)
      values ('o1', '00000000-0000-4000-8000-000000000001', '10001', 'P-1', 'Old issue', 'Story',
              '1', now(), now())`);
    await runMigrations(tdb.ownerUrl);
  });
  afterAll(async () => {
    await owner?.close();
    await tdb?.stop();
    if (before) rmSync(before, { recursive: true, force: true });
  });

  it('gives old issues empty lists and null fields, and resets the full sync', async () => {
    const issues = await owner.db.execute(sql`
      select labels, components, fix_versions, priority, epic_key, epic_name from jira_issues`);
    expect([...issues]).toEqual([
      {
        labels: [],
        components: [],
        fix_versions: [],
        priority: null,
        epic_key: null,
        epic_name: null,
      },
    ]);
    const boards = await owner.db.execute(sql`select last_full_sync_at from jira_boards`);
    expect([...boards]).toEqual([{ last_full_sync_at: null }]);
  });
});
