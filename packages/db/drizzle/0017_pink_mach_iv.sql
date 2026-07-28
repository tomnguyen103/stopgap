-- Ticket 13 — the daily brief. A TENANT table.
--
-- Table DDL is `drizzle-kit generate` output; the row-level security block below is HAND-ADDED,
-- because drizzle cannot express a policy.
--
-- `degraded_reason` is the honest-failure column. A brief the compliance guard refused, or one no
-- model could be reached to write, is RECORDED as such rather than dropped — a director who sees
-- no brief cannot tell "nothing happened" from "the system produced something it would not show
-- you", and those need different responses.
--
-- Purely additive: one new table, no existing column, index or row is touched.

CREATE TABLE "daily_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brief_date" text NOT NULL,
	"headline" text NOT NULL,
	"changes" jsonb NOT NULL,
	"newly_at_risk" jsonb NOT NULL,
	"needs_review" jsonb NOT NULL,
	"signal_keys" jsonb NOT NULL,
	"degraded_reason" text,
	"model" text,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daily_briefs" ADD CONSTRAINT "daily_briefs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_briefs_date_uq" ON "daily_briefs" USING btree ("org_id","brief_date");--> statement-breakpoint
CREATE INDEX "daily_briefs_recent_idx" ON "daily_briefs" USING btree ("org_id","generated_at");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Row-level security, same shape as 0013 (ENABLE + FORCE + symmetric USING/WITH CHECK).
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "daily_briefs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "daily_briefs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "daily_briefs_org_isolation" ON "daily_briefs"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);
