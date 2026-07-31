# `pnpm db:migrate` tried to re-run migration 0013 and died on "relation alert_events already exists"

Hit while applying migration 0022 to the local development database. The symptom points at
the new migration; the cause is three migrations back, in bookkeeping rather than in SQL.

## Symptom

```text
[migrate] failed: PostgresError: relation "alert_events" already exists
  code: '42P07'
```

`42P07` is `duplicate_table`. Nothing in 0022 creates `alert_events` — that table has
existed since migration 0013 — so the runner was replaying an old migration, not applying
the new one.

## What did not work

Reading 0022. The generated SQL was correct, and re-reading it three times found nothing,
because the file was never the problem. The clue that redirects the search is that the
error names a table the migration under test does not mention: that is always a runner
question, not a DDL question.

## Root cause

`drizzle-orm/postgres-js/migrator` decides what to apply by comparing each journal entry's
`when` timestamp in `packages/db/drizzle/meta/_journal.json` against the newest
`created_at` in the `drizzle.__drizzle_migrations` table. Anything newer than the newest
recorded row is treated as unapplied and replayed from its first statement.

The local database had drifted:

```text
select count(*) from drizzle.__drizzle_migrations;   -- 20
select max(created_at) from drizzle.__drizzle_migrations;  -- 1785260568893
```

Twenty rows, while the journal holds twenty-three entries — and the newest recorded
timestamp sits *below* the `when` of 0019, 0020 and 0021. The schema itself was fully at
0021 (`pnpm test:rls` passed all 241 tests, including the ticket-21 composite-key probes),
so the tables were there; only the ledger saying so was missing. Those three had been
applied by some route that does not write the ledger — a hand-run `psql`, or a restore.

So the runner set out to replay 0019 onwards, and 0019's first `CREATE TABLE` for an
already-existing table ended it.

## Fix

For the local database, apply the new migration by hand and leave the ledger alone:

```bash
docker cp packages/db/drizzle/0022_breezy_lord_tyger.sql stopgap-postgres-1:/tmp/0022.sql
MSYS_NO_PATHCONV=1 docker exec stopgap-postgres-1 \
  psql -U stopgap -d stopgap -v ON_ERROR_STOP=1 -f //tmp/0022.sql
```

Two Git Bash details in that second command, both of which fail confusingly without the
workaround: `MSYS_NO_PATHCONV=1` stops MSYS rewriting the container path into a Windows
one (`psql: error: C:/Users/.../Temp/0022.sql: No such file or directory`), and the
doubled slash in `//tmp/0022.sql` is the same defence for the `-f` argument.

## What actually proves a migration is correct

Not `pnpm db:migrate` against a developer's database — that only proves the migration
applies to *that* database, whatever state it has drifted into.

`packages/db/src/migrations.e2e.test.ts` creates a throwaway database, applies **every**
migration in order as the owner, and then asserts the hand-written halves ran (RLS
`ENABLE` **and** `FORCE`, and a policy per table). It runs in `pnpm test:rls`. That is the
authority, and it is the reason a drifted local ledger is an inconvenience rather than a
release risk.

## The general rule

A migration error that names an object the migration does not touch is a bookkeeping
failure, not a DDL failure. Check `drizzle.__drizzle_migrations` against
`meta/_journal.json` before re-reading the SQL. And never repair the drift by editing an
applied migration file: its hash and its `when` are the ledger's only handles on it.
