-- Ticket 09 — evidence artifacts. A TENANT table.
--
-- Table DDL is `drizzle-kit generate` output; the row-level security block below is HAND-ADDED,
-- because drizzle cannot express a policy and a tenant table without one is a table every tenant
-- can read in full.
--
-- WHAT THIS TABLE DELIBERATELY DOES NOT HOLD: content. No provider body, no fetched page, no
-- excerpt — only where the claim came from, when it was captured, and a SHA-256 of what was seen.
-- That is enough for a pharmacist to check the source and for an auditor to prove the record has
-- not changed, and it keeps a table whose whole purpose is long retention free of text a hospital
-- would have to treat as protected once stored.
--
-- Purely additive: one new table, no existing column, index or row is touched.

CREATE TABLE "signal_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"signal_id" uuid NOT NULL,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"feed_record_id" uuid,
	"origin_url" text NOT NULL,
	"content_hash" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signal_evidence" ADD CONSTRAINT "signal_evidence_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_evidence" ADD CONSTRAINT "signal_evidence_signal_id_risk_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."risk_signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_evidence" ADD CONSTRAINT "signal_evidence_feed_record_id_feed_records_id_fk" FOREIGN KEY ("feed_record_id") REFERENCES "public"."feed_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "signal_evidence_point_uq" ON "signal_evidence" USING btree ("org_id","signal_id","type","content_hash");--> statement-breakpoint
CREATE INDEX "signal_evidence_signal_idx" ON "signal_evidence" USING btree ("org_id","signal_id","captured_at");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Row-level security, same shape as 0013 (ENABLE + FORCE + symmetric USING/WITH CHECK).
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "signal_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "signal_evidence" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "signal_evidence_org_isolation" ON "signal_evidence"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);
