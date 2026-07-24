CREATE TABLE "protocol_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"protocol_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"body" text NOT NULL,
	"alternatives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_case_id" uuid,
	"authored_by" text NOT NULL,
	"approved_by" text,
	"rationale" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "protocols" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"drug_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shadow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"corpus_id" text NOT NULL,
	"key" text NOT NULL,
	"drug_class" text,
	"proposed_severity" text NOT NULL,
	"proposed_alternatives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"baseline_severity" text NOT NULL,
	"baseline_alternatives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agreement" numeric(4, 3) NOT NULL,
	"severity_agreed" boolean NOT NULL,
	"latency_ms" integer NOT NULL,
	"usd_cost" numeric(12, 8) NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "protocol_versions" ADD CONSTRAINT "protocol_versions_protocol_id_protocols_id_fk" FOREIGN KEY ("protocol_id") REFERENCES "public"."protocols"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocol_versions" ADD CONSTRAINT "protocol_versions_source_case_id_cases_id_fk" FOREIGN KEY ("source_case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "protocol_versions_uq" ON "protocol_versions" USING btree ("protocol_id","version");--> statement-breakpoint
CREATE INDEX "protocol_versions_state_idx" ON "protocol_versions" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "protocols_key_uq" ON "protocols" USING btree ("key");--> statement-breakpoint
CREATE INDEX "protocols_class_idx" ON "protocols" USING btree ("drug_class");--> statement-breakpoint
CREATE INDEX "shadow_runs_key_idx" ON "shadow_runs" USING btree ("key");--> statement-breakpoint
CREATE INDEX "shadow_runs_class_idx" ON "shadow_runs" USING btree ("drug_class");--> statement-breakpoint
CREATE INDEX "shadow_runs_ran_at_idx" ON "shadow_runs" USING btree ("ran_at");