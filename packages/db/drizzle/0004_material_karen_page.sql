-- run_id becomes NOT NULL DEFAULT '': Postgres treats NULLs as distinct in a unique index, so
-- a nullable run_id would switch the (case_id, action, run_id) idempotency backstop off for
-- exactly the rows that have no run context.
--
-- Backfill: rows written before run_id existed are NULL. The first row of each
-- (case_id, action) takes '', and any further NULL rows for the same pair — only possible for
-- rows written in the window while run_id was nullable — take a stable synthetic value, so no
-- audit row is deleted to satisfy the new constraint.
UPDATE "audit_log" a
SET "run_id" = CASE
  WHEN a."id" = (
    SELECT MIN(b."id") FROM "audit_log" b
    WHERE b."case_id" IS NOT DISTINCT FROM a."case_id" AND b."action" = a."action" AND b."run_id" IS NULL
  ) THEN ''
  ELSE 'legacy-' || a."id"::text
END
WHERE a."run_id" IS NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "run_id" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "run_id" SET NOT NULL;