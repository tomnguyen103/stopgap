CREATE TABLE "user_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"oidc_subject" text,
	"email" text,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "protocol_versions" ADD COLUMN "authored_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "protocol_versions" ADD COLUMN "approved_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_roles_user_role_uq" ON "user_roles" USING btree ("user_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "users_oidc_subject_uq" ON "users" USING btree ("oidc_subject") WHERE "users"."oidc_subject" is not null;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocol_versions" ADD CONSTRAINT "protocol_versions_authored_by_user_id_users_id_fk" FOREIGN KEY ("authored_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocol_versions" ADD CONSTRAINT "protocol_versions_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- PHASE6 §6.1 backfill (hand-written; drizzle-kit does not generate data migrations).
-- Seed the two synthetic principals of the audit chain with fixed ids (matching
-- SYNTHETIC_USER_IDS in src/users.ts), then point legacy rows whose text actor/author maps
-- to a machine principal at the corresponding users.id. This is ADDITIVE: the text columns
-- (`actor`, `authored_by`, `approved_by`) — the values the hash-chain commits to — are left
-- untouched, so `verifyAuditChain` still passes byte-for-byte across this migration. Human
-- labels ("pharmacist-console", "unknown-reviewer") have no synthetic mapping and keep a NULL
-- FK with their text label intact.
INSERT INTO "users" ("id", "oidc_subject", "email", "display_name") VALUES
  ('00000000-0000-0000-0000-000000000001', 'system', NULL, 'System'),
  ('00000000-0000-0000-0000-000000000002', 'agent', NULL, 'Agent')
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "audit_log" SET "actor_user_id" = '00000000-0000-0000-0000-000000000001' WHERE "actor" = 'system' AND "actor_user_id" IS NULL;--> statement-breakpoint
UPDATE "audit_log" SET "actor_user_id" = '00000000-0000-0000-0000-000000000002' WHERE "actor" = 'agent' AND "actor_user_id" IS NULL;--> statement-breakpoint
UPDATE "protocol_versions" SET "authored_by_user_id" = '00000000-0000-0000-0000-000000000002' WHERE "authored_by" = 'agent' AND "authored_by_user_id" IS NULL;