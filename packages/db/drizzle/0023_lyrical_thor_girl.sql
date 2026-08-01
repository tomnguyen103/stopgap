ALTER TABLE "demo_runs" ADD COLUMN "visitor_id" text;--> statement-breakpoint
CREATE INDEX "demo_runs_visitor_idx" ON "demo_runs" USING btree ("org_id","visitor_id","started_at");