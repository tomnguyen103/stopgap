-- Ticket 12 — alert rules and the events they produce. Both TENANT tables.
--
-- Table DDL is `drizzle-kit generate` output, REORDERED by hand: the unique constraint on
-- `alert_rules (org_id, id)` has to exist before the composite foreign key that references it, and
-- drizzle emitted it after.
--
-- WHY COMPOSITE. A plain foreign key to `alert_rules.id` proves the rule exists; it does not prove
-- it belongs to the tenant filing the event. The referential check runs with RLS bypassed and
-- `org_id` is written by the calling function, so an event naming ANOTHER tenant's rule would pass
-- both the FK and `WITH CHECK`. Requiring the pair makes that unrepresentable.
--
-- WHAT THESE TABLES DO NOT OWN: who is told, whether they acknowledged, and what happens when
-- nobody does. That stays with `escalation_policies` and `acknowledgments`. Rules own TRIGGERING;
-- the ladder owns OWNERSHIP.
--
-- Purely additive: two new tables, no existing column, index or row is touched.

CREATE TABLE "alert_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"matched_count" integer NOT NULL,
	"matched_keys" jsonb NOT NULL,
	"deliveries" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"fired_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"risk_domain" text,
	"entity_contains" text,
	"min_severity" text NOT NULL,
	"cooldown_minutes" integer DEFAULT 60 NOT NULL,
	"channels" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "alert_rules_org_id_uq" ON "alert_rules" USING btree ("org_id","id");--> statement-breakpoint
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_org_rule_fk" FOREIGN KEY ("org_id","rule_id") REFERENCES "public"."alert_rules"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_events_idempotency_uq" ON "alert_events" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "alert_events_rule_idx" ON "alert_events" USING btree ("org_id","rule_id","fired_at");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_rules_name_uq" ON "alert_rules" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "alert_rules_enabled_idx" ON "alert_rules" USING btree ("org_id","enabled");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Row-level security, same shape as 0013 (ENABLE + FORCE + symmetric USING/WITH CHECK).
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "alert_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "alert_rules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "alert_rules_org_isolation" ON "alert_rules"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);--> statement-breakpoint

ALTER TABLE "alert_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "alert_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "alert_events_org_isolation" ON "alert_events"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);
