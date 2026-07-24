CREATE TABLE "audit_anchors" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"max_audit_id" bigint NOT NULL,
	"head_hash" text NOT NULL,
	"sink" text NOT NULL,
	"sink_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "scheme" text DEFAULT 'v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "feed_miss_count" integer DEFAULT 0 NOT NULL;