-- Ticket 09 — evidence artifacts, plus the composite tenant keys that make a cross-tenant
-- reference unrepresentable.
--
-- Table DDL is `drizzle-kit generate` output, REORDERED by hand: drizzle emitted the unique
-- constraint on `risk_signals (org_id, id)` last, after the foreign keys that reference it, which
-- fails. It is moved above them here.
--
-- WHY THE COMPOSITE KEYS. A plain foreign key to `risk_signals.id` proves the signal exists; it
-- does not prove it belongs to the tenant filing the row. The referential check runs with RLS
-- bypassed, and `org_id` is written by the calling function — so a snapshot or artifact naming
-- ANOTHER tenant's signal passes both the FK and `WITH CHECK` and lands. Requiring the PAIR to
-- match makes that combination impossible in the database rather than a rule application code has
-- to remember. The single-column FK is dropped in the same statement set, because it enforces a
-- strictly weaker condition twice.
--
-- WHAT `signal_evidence` DELIBERATELY DOES NOT HOLD: content. Only where the claim came from, when
-- it was captured, and a SHA-256 of what was seen. The trail outlives the signal whose payload it
-- points at, which makes it the worst place to be holding provider prose a hospital would then
-- have to treat as protected.
--
-- Additive apart from the redundant FK drop: no column is removed and no row is deleted.

CREATE TABLE "signal_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"signal_id" uuid NOT NULL,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"origin_url" text NOT NULL,
	"content_hash" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
ALTER TABLE "risk_score_snapshots" DROP CONSTRAINT "risk_score_snapshots_signal_id_risk_signals_id_fk";--> statement-breakpoint
CREATE UNIQUE INDEX "risk_signals_org_id_uq" ON "risk_signals" USING btree ("org_id","id");--> statement-breakpoint
ALTER TABLE "signal_evidence" ADD CONSTRAINT "signal_evidence_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_evidence" ADD CONSTRAINT "signal_evidence_org_signal_fk" FOREIGN KEY ("org_id","signal_id") REFERENCES "public"."risk_signals"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "signal_evidence_point_uq" ON "signal_evidence" USING btree ("org_id","signal_id","type","content_hash");--> statement-breakpoint
CREATE INDEX "signal_evidence_signal_idx" ON "signal_evidence" USING btree ("org_id","signal_id","captured_at");--> statement-breakpoint
ALTER TABLE "risk_score_snapshots" ADD CONSTRAINT "risk_score_snapshots_org_signal_fk" FOREIGN KEY ("org_id","signal_id") REFERENCES "public"."risk_signals"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Row-level security, same shape as 0013 (ENABLE + FORCE + symmetric USING/WITH CHECK).
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "signal_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "signal_evidence" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "signal_evidence_org_isolation" ON "signal_evidence"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);
