DROP INDEX "audit_case_action_uq";--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "run_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_case_action_uq" ON "audit_log" USING btree ("case_id","action","run_id");