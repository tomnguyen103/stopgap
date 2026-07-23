CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"case_id" uuid,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" text NOT NULL,
	"key" text NOT NULL,
	"generic_name" text NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"status" text DEFAULT 'detected' NOT NULL,
	"severity" text,
	"ndcs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_note" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "feed_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"key" text NOT NULL,
	"status" text NOT NULL,
	"payload" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_case_idx" ON "audit_log" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "audit_ts_idx" ON "audit_log" USING btree ("ts");--> statement-breakpoint
CREATE UNIQUE INDEX "cases_workflow_id_uq" ON "cases" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "cases_status_idx" ON "cases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "cases_key_idx" ON "cases" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "feed_records_source_uq" ON "feed_records" USING btree ("source","source_id");