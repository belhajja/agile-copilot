# Writing migrations

Migrations live in `packages/db/drizzle` and are generated from the schema with
`pnpm db:generate` (drizzle-kit). Review and edit the generated SQL before committing it: it is
what runs in production.

## How they run

- **Forward only.** There are no down migrations. Rolling back means deploying the previous image
  against the newer schema, so every migration must leave a schema the previous release still
  works with.
- **One transaction for the whole upgrade.** drizzle's migrator (`drizzle-orm/postgres-js/migrator`,
  see `packages/db/src/migrate.ts`) applies every pending migration inside a single transaction:
  an upgrade that skips several releases is all or nothing, and every lock taken by an early
  statement is held until the last one commits.
- **Old pods keep serving meanwhile.** On Kubernetes the migrations run in a pre-install/pre-upgrade
  Job (`backoffLimit: 0`, `activeDeadlineSeconds: 240` by default, under Helm's 5-minute
  `--timeout`); the old pods serve traffic during the Job and during the rolling update after it.
  A Job killed at its deadline rolls the transaction back and the upgrade fails: nothing is
  half-applied, but nothing is retried either.

So a migration must be quick, must not hold locks that block the running app for long, and must be
compatible with the code of both the previous and the new release.

## Expand, then contract

Never rename, drop or change the type of a column the running code uses in the same release that
stops using it. Spread the change over releases:

1. **Expand:** add the new column or table (nullable, or `NOT NULL` with a constant `DEFAULT`,
   which PostgreSQL 11+ adds without rewriting the table). The new code writes both the old and the
   new column and reads the new one, falling back to the old.
2. **Backfill** the existing rows (next section).
3. **Switch:** the next release reads and writes only the new column. To make it `NOT NULL`
   without scanning the table under an exclusive lock, add
   `CHECK ("col" IS NOT NULL) NOT VALID`, then `VALIDATE CONSTRAINT` (it allows reads and writes
   while it scans), then `SET NOT NULL`, which uses the validated constraint, and drop the check.
4. **Contract:** a later release drops the old column once no deployed version reads it.

The same goes for type changes (`ALTER COLUMN ... SET DATA TYPE` rewrites the table under an
exclusive lock): add a column of the new type, backfill, switch, drop.

Statements that touch a busy table (`jira_issues`, `session`, ...) should not wait in the lock
queue behind a long query, which would block every query behind them. Start such a migration with
`SET LOCAL lock_timeout = '5s';`: the upgrade then fails fast and can be retried, instead of
stalling the app. (`SET LOCAL` lasts until the migrator's transaction ends.)

## Backfill separately

Do not update every row of a large table inside a migration: it runs in the upgrade transaction,
holds row locks until the commit and has to finish within the Job's deadline. Instead:

- ship the column in one release (expand), with code that fills it for new and updated rows;
- backfill the existing rows in batches (a few thousand rows per transaction, by primary key
  range) from a script or a worker job, idempotent so it can be stopped and run again;
- add the constraint (`NOT NULL`, foreign key `NOT VALID` then `VALIDATE`) in a later migration,
  once the backfill is done everywhere.

A data change on a small table (settings, a few rows per workspace) can stay in the migration.

## Indexes on populated tables

A plain `CREATE INDEX` blocks writes to the table until the index is built. `CREATE INDEX
CONCURRENTLY` does not, but PostgreSQL refuses it inside a transaction block, and drizzle's
migrator always runs migrations in one: a `CONCURRENTLY` in a migration file fails the whole
upgrade. For an index on a table that may hold many rows:

1. In the migration, write the index as drizzle-kit generates it, but with `IF NOT EXISTS`
   (edit the generated SQL; the snapshot does not change):

   ```sql
   CREATE INDEX IF NOT EXISTS "my_table_my_col_idx" ON "my_table" USING btree ("my_col");
   ```

   On a new or small database the migration builds it; where it already exists it does nothing.
2. In the release notes (`CHANGELOG.md`), give operators of large databases the same statement
   with `CONCURRENTLY`, to run with `psql` as the migration owner **before** upgrading (psql runs
   each statement in its own transaction):

   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS "my_table_my_col_idx" ON "my_table" USING btree ("my_col");
   ```

3. A concurrent build that fails (deadlock, cancelled, unique violation) leaves an **invalid**
   index, which `IF NOT EXISTS` then accepts as it is. Check before upgrading:

   ```sql
   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
   ```

   and `DROP INDEX CONCURRENTLY` any listed index, then build it again.

A unique constraint follows the same path: build the unique index concurrently, then
`ALTER TABLE ... ADD CONSTRAINT ... UNIQUE USING INDEX ...` in the migration.

## Row-level security

A new table that holds workspace data gets the app role's grants and `ENABLE` / `FORCE ROW LEVEL
SECURITY` with its policy, as in the earlier `*_force_rls.sql` migrations;
`packages/db/src/rls.test.ts` checks every table with an `org_id`.

## Testing a migration

- `pnpm vitest run packages/db` applies every migration from scratch to a Testcontainers Postgres.
- A migration that changes existing data gets a test like
  `packages/db/src/query-fields-migration.test.ts`: migrate a copy of the folder whose journal
  stops before it, insert rows the way the previous release wrote them, then migrate from the real
  folder and check the rows.
- Before releasing a migration that rewrites a table, takes strong locks or builds indexes, run
  it against a copy of a production-sized database and time it against the Job's deadline:

  ```sh
  pg_dump -Fc "$PROD_OWNER_URL" > agile.dump            # or restore last night's backup
  docker run -d --name agile-mig -e POSTGRES_PASSWORD=x -p 5499:5432 postgres:17-alpine
  psql postgres://postgres:x@localhost:5499/postgres -c "CREATE ROLE app_user LOGIN PASSWORD 'x'" \
    -c "CREATE DATABASE agile"
  pg_restore --no-owner -d postgres://postgres:x@localhost:5499/agile agile.dump
  time DATABASE_OWNER_URL=postgres://postgres:x@localhost:5499/agile pnpm db:migrate
  docker rm -f agile-mig
  ```

  While it runs, `SELECT pid, wait_event_type, state, query FROM pg_stat_activity` on the copy
  shows what it waits on. If it needs more than the deadline, raise
  `migrate.activeDeadlineSeconds` together with Helm's `--timeout`, or move the slow part out of
  the migration (backfill, concurrent index).
