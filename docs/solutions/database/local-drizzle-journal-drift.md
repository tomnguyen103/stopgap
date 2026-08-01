# Local Drizzle journal drift blocked the generated migration

## Problem

The generated visitor-quota migration was correct, but `pnpm --filter @stopgap/db migrate` could not
apply it to the existing local development database. Drizzle attempted to replay an earlier table
creation and failed on an already-existing relation before reaching migration `0023`.

## Root cause

`packages/db/src/migrate.ts:8-14` asks Drizzle's migrator to apply the repository's generated
`packages/db/drizzle` folder against the live database journal. The local
`drizzle.__drizzle_migrations` history had entries from a different development migration lineage
than the checked-in journal, while the corresponding tables already existed. The failure was
history drift, not a defect in the new `demo_runs.visitor_id` SQL.

## Recovery and boundary

Do not rewrite migration history or rerun the full folder blindly against this preserved dev
database. Apply the exact generated `0023_lyrical_thor_girl.sql` statements idempotently to the
local database (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`).
Production deployments still use the normal migrator against a database whose journal is created
from this repository's migration chain.
