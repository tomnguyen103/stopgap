-- Ticket 06 — normalized signals and the score snapshots derived from them, both TENANT tables.
--
-- Table DDL is `drizzle-kit generate` output. The row-level security block at the bottom is
-- HAND-ADDED, for the reason 0013 gave: drizzle can express columns, indexes and foreign keys, and
-- cannot express a policy. A new tenant table without a policy is not a missing feature — it is a
-- table any authenticated tenant can read in full.
--
-- WHY THESE ARE TENANT AND `feed_records` IS NOT. A feed record is one physical fact about the drug
-- supply, byte-identical for every hospital, stored once. A risk signal is that fact interpreted
-- for one facility — its own dedupe key, its own resolution state, its own weighting. Two hospitals
-- reading the same recall hold genuinely different signals, so the same §6.5 test that keeps
-- `feed_records` global puts these two here.
--
-- Purely additive: two new tables, no existing column, index or row is touched.

CREATE TABLE "risk_score_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"signal_id" uuid NOT NULL,
	"score" numeric(6, 2) NOT NULL,
	"band" text NOT NULL,
	"components" jsonb NOT NULL,
	"scorer_version" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"risk_domain" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_identifier" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"severity" text NOT NULL,
	"severity_score" numeric(5, 4) NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"last_fetched_at" timestamp with time zone NOT NULL,
	"staleness" text NOT NULL,
	"source_resolved" boolean DEFAULT false NOT NULL,
	"feed_miss_count" integer DEFAULT 0 NOT NULL,
	"last_feed_poll_run" text,
	"evidence_url" text NOT NULL,
	"raw" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"match_hints" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "risk_score_snapshots" ADD CONSTRAINT "risk_score_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_score_snapshots" ADD CONSTRAINT "risk_score_snapshots_signal_id_risk_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."risk_signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_signals" ADD CONSTRAINT "risk_signals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "risk_score_snapshots_point_uq" ON "risk_score_snapshots" USING btree ("org_id","signal_id","scorer_version","computed_at");--> statement-breakpoint
CREATE INDEX "risk_score_snapshots_rank_idx" ON "risk_score_snapshots" USING btree ("org_id","computed_at","score");--> statement-breakpoint
CREATE INDEX "risk_score_snapshots_signal_idx" ON "risk_score_snapshots" USING btree ("org_id","signal_id","computed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_signals_dedupe_uq" ON "risk_signals" USING btree ("org_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "risk_signals_domain_idx" ON "risk_signals" USING btree ("org_id","risk_domain","published_at");--> statement-breakpoint
CREATE INDEX "risk_signals_entity_idx" ON "risk_signals" USING btree ("org_id","entity_identifier");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Row-level security. Same shape as 0013: ENABLE turns policies on for ordinary roles, FORCE
-- applies them to the table owner too (without it the owner — which is what a migration and most
-- local psql sessions connect as — silently bypasses every policy, and the isolation suite goes
-- green while proving nothing), and the two-argument `current_setting(..., true)` returns NULL
-- rather than erroring when no tenant scope is set, so an unscoped connection reads ZERO rows.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "risk_signals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "risk_signals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "risk_signals_org_isolation" ON "risk_signals"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);--> statement-breakpoint

ALTER TABLE "risk_score_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "risk_score_snapshots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "risk_score_snapshots_org_isolation" ON "risk_score_snapshots"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);
