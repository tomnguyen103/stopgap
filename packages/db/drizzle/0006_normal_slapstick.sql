CREATE TABLE "llm_spend" (
	"day" text PRIMARY KEY NOT NULL,
	"usd_cost" numeric(12, 8) DEFAULT '0' NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
