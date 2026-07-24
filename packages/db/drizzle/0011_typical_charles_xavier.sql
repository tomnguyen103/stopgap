CREATE TABLE "acknowledgments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"step" integer NOT NULL,
	"ack_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escalation_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"severity" text NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "acknowledgments" ADD CONSTRAINT "acknowledgments_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acknowledgments" ADD CONSTRAINT "acknowledgments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "acknowledgments_case_step_uq" ON "acknowledgments" USING btree ("case_id","step");--> statement-breakpoint
CREATE INDEX "acknowledgments_case_idx" ON "acknowledgments" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "escalation_policies_severity_uq" ON "escalation_policies" USING btree ("severity");--> statement-breakpoint
-- PHASE6 §6.3 seed (hand-written; drizzle-kit does not generate data migrations).
-- Default on-call ladders so `docker compose up` escalates without a human first editing config.
-- `afterMinutes` is the delay from escalation start before that tier is paged (0 = immediate);
-- an admin can overwrite these via upsertEscalationPolicy. ON CONFLICT DO NOTHING keeps a re-run
-- (or a deployment that already customised a ladder) from clobbering an operator's edits.
INSERT INTO "escalation_policies" ("severity", "steps") VALUES
  ('critical', '[{"afterMinutes":0,"notify":"pharmacist"},{"afterMinutes":30,"notify":"pharmacy_director"},{"afterMinutes":60,"notify":"admin"}]'::jsonb),
  ('high', '[{"afterMinutes":0,"notify":"pharmacist"},{"afterMinutes":120,"notify":"pharmacy_director"}]'::jsonb)
ON CONFLICT ("severity") DO NOTHING;