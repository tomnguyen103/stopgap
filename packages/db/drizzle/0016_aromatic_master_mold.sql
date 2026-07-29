-- Ticket 07 — the deterministic scorer.
--
-- `risk_score_snapshots.reachable_max`: the points a score COULD have earned, given what was
-- knowable when it was computed. 65 while the catalog components are dormant, 100 once inventory
-- and supplier data land. Stored rather than recomputed, because a reader comparing two snapshots
-- taken either side of that change needs to know which denominator each was scored against —
-- otherwise a score that rose because more became knowable is indistinguishable from one that rose
-- because the hazard got worse.
--
-- HAND-EDITED after `drizzle-kit generate`, which emitted a bare `ADD COLUMN … NOT NULL`. That
-- form fails outright on any table that already has rows, which is every deployment that has run
-- the poll since 0015. The nullable → backfill → SET NOT NULL dance is what 0013 and 0014 both
-- used, for the same reason, and it is what makes this migration runnable against real data rather
-- than only against an empty database.
--
-- The backfill value is 65 rather than 100 because that is what those rows were actually scored
-- against: every snapshot written before this migration came from a poll with no catalog data.
-- Writing 100 would retroactively claim they were scored on a basis they never had.
--
-- Additive: no column is dropped, no row is deleted, and no existing value changes.
--
-- `risk_score_snapshots_signal_idx` was created here on the branch this ticket was built on, where
-- 0015 had declared it in the Drizzle schema without emitting the DDL. 0015 creates it now, so
-- repeating the statement here would abort this migration on every database that ran 0015 —
-- the index is the same one, not a second one, and one migration owns it.

ALTER TABLE "risk_score_snapshots" ADD COLUMN "reachable_max" numeric(6, 2);--> statement-breakpoint
UPDATE "risk_score_snapshots" SET "reachable_max" = 65 WHERE "reachable_max" IS NULL;--> statement-breakpoint
ALTER TABLE "risk_score_snapshots" ALTER COLUMN "reachable_max" SET NOT NULL;
