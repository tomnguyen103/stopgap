DROP INDEX "audit_case_action_uq";--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "event_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Existing rows predate event_key; their logical event was the action itself, and leaving
-- them all at '' would make every row of a case collide on the new unique index.
UPDATE "audit_log" SET "event_key" = "action" WHERE "event_key" = '';--> statement-breakpoint
ALTER TABLE "shadow_runs" ADD COLUMN "severity_under_called" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_case_action_uq" ON "audit_log" USING btree ("case_id","event_key","run_id");