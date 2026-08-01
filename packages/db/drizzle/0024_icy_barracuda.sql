ALTER TABLE "shadow_runs" ADD COLUMN "replay_day" date;--> statement-breakpoint
-- Legacy shadow rows may contain repeated replays for one corpus entry on one day. Preserve every
-- row, derive the day from the measured timestamp, and leave same-day duplicates NULL so the new
-- partial unique index can enforce idempotence for fresh replay rows without deleting evidence.
WITH ranked AS (
  SELECT
    id,
    (ran_at AT TIME ZONE 'UTC')::date AS replay_day,
    row_number() OVER (
      PARTITION BY org_id, corpus_id, (ran_at AT TIME ZONE 'UTC')::date
      ORDER BY ran_at, id
    ) AS occurrence
  FROM "shadow_runs"
)
UPDATE "shadow_runs" AS shadow
SET "replay_day" = ranked.replay_day
FROM ranked
WHERE shadow.id = ranked.id
  AND ranked.occurrence = 1;--> statement-breakpoint
ALTER TABLE "shadow_runs" ALTER COLUMN "replay_day" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date;--> statement-breakpoint
CREATE UNIQUE INDEX "shadow_runs_org_corpus_day_uq" ON "shadow_runs" USING btree ("org_id","corpus_id","replay_day") WHERE "shadow_runs"."replay_day" is not null;
