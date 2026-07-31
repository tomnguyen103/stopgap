-- Ticket 17 — per-tenant connector health, and the two deferred batch-A performance findings.
--
-- Two unrelated things in one migration on purpose: they are the whole remaining schema debt of the
-- programme, and splitting them would take two ACCESS EXCLUSIVE windows where one does.
--
-- LOCKS. The four `CREATE INDEX` statements below each take a SHARE lock on their table for the
-- duration of the build, which blocks writes — and drizzle runs a migration in ONE transaction, so
-- the blocking is the SUM of the four. On an aged deployment `risk_signals` and `procurement_events`
-- are the large ones. `lock_timeout` is set for the same reason migration 0021 sets it: better to
-- fail fast than to queue behind a long reader and stall every writer behind it in turn. If it
-- trips, run this in a maintenance window; do not raise the timeout.
--
-- NOT `CREATE INDEX CONCURRENTLY`: that cannot run inside a transaction block, and the migration
-- runner owns the transaction. A deployment large enough to care should build these by hand,
-- concurrently, and then run this migration — the `IF NOT EXISTS` on each makes that safe.

SET lock_timeout = '10s';--> statement-breakpoint

CREATE TABLE "connector_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"source" text NOT NULL,
	"ran_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"signal_count" integer DEFAULT 0 NOT NULL,
	"last_ok_at" timestamp with time zone,
	"detail" text
);
--> statement-breakpoint
ALTER TABLE "connector_runs" ADD CONSTRAINT "connector_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_runs_source_uq" ON "connector_runs" USING btree ("org_id","source");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Row-level security for the new tenant table, in the form every tenant table here already takes
-- (migrations 0013 and 0020). FORCE as well as ENABLE, so the table owner is subject to the policy
-- too. `current_setting(..., true)` is the missing-GUC-tolerant form: an unscoped connection reads
-- ZERO rows rather than erroring in a way a caller might catch and treat as empty.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "connector_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "connector_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "connector_runs_org_isolation" ON "connector_runs"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Batch-A review finding 11 — the retention sweep's predicate is `(org_id, <age column>)`, and four
-- of the five swept kinds had no index that could serve it. Each table below already carried an
-- index leading with `org_id`, but with a column the sweep does not filter on in second position,
-- so the age range fell back to a scan of the tenant's whole table on every scheduled cleanup.
-- `risk_score_snapshots` is the fifth and needs nothing: `risk_score_snapshots_rank_idx` is
-- `(org_id, computed_at, score)`, which already serves it.
-- ---------------------------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "alert_events_retention_idx" ON "alert_events" USING btree ("org_id","fired_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_snapshots_retention_idx" ON "inventory_snapshots" USING btree ("org_id","captured_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procurement_events_retention_idx" ON "procurement_events" USING btree ("org_id","ordered_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "risk_signals_retention_idx" ON "risk_signals" USING btree ("org_id","updated_at");
