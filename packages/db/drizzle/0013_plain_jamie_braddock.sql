-- PHASE6 §6.5 — multi-tenancy: organizations, org_id on every tenant table, and Postgres
-- row-level security.
--
-- HAND-EDITED after `drizzle-kit generate`. Drizzle can express the columns and the indexes; it
-- cannot express the backfill or the policies, and the order below is load-bearing:
--
--   1. create `organizations` and insert the seed org;
--   2. add every `org_id` column NULLABLE, backfill it to the seed org, THEN `SET NOT NULL`
--      (a NOT NULL column added directly fails on any non-empty table — which is every table in
--      an existing deployment — so the three-step dance is what makes this migration runnable
--      against real data rather than only against an empty database);
--   3. add the foreign keys, now that no NULLs remain;
--   4. drop and recreate the indexes that became org-composites;
--   5. create the maintenance role and enable RLS.
--
-- Additive throughout: no column is dropped, no row is deleted, and every existing row keeps
-- every value it had. The only destructive-looking statements are the index drops in step 4, each
-- immediately recreated in a wider form.

CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_uq" ON "organizations" USING btree ("slug");--> statement-breakpoint

-- The seed organization. Its id is the literal `SEED_ORG_ID` in `packages/db/src/orgs.ts`, fixed
-- rather than generated so this backfill and the application code agree on which org the
-- pre-multi-tenancy world became WITHOUT a lookup, and so the same id means the same tenant in
-- every deployment (a dump from one machine stays readable on another). ON CONFLICT DO NOTHING
-- keeps the statement idempotent if the row was seeded by hand first.
INSERT INTO "organizations" ("id", "slug", "name")
VALUES ('00000000-0000-0000-0000-0000000000a1', 'stopgap', 'Stopgap (seed organization)')
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. org_id columns: NULLABLE -> backfill -> NOT NULL.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "acknowledgments" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "demo_runs" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "protocol_versions" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "protocols" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "shadow_runs" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "org_id" uuid;--> statement-breakpoint

-- Every pre-existing row belongs to the one tenant that existed before this migration. Note what
-- this does NOT do: it does not touch `audit_log.hash` or `prev_hash`. Schemes `v1`-`v3` do not
-- hash `org_id`, so backfilling it leaves every historical hash byte-identical and the chain
-- verifies exactly as it did before. That is the entire reason `v4` is a NEW scheme rather than a
-- widening of `v3` (see `packages/db/src/audit.ts`).
UPDATE "acknowledgments" SET "org_id" = '00000000-0000-0000-0000-0000000000a1' WHERE "org_id" IS NULL;--> statement-breakpoint
UPDATE "api_keys" SET "org_id" = '00000000-0000-0000-0000-0000000000a1' WHERE "org_id" IS NULL;--> statement-breakpoint
UPDATE "audit_log" SET "org_id" = '00000000-0000-0000-0000-0000000000a1' WHERE "org_id" IS NULL;--> statement-breakpoint
UPDATE "cases" SET "org_id" = '00000000-0000-0000-0000-0000000000a1' WHERE "org_id" IS NULL;--> statement-breakpoint
UPDATE "demo_runs" SET "org_id" = '00000000-0000-0000-0000-0000000000a1' WHERE "org_id" IS NULL;--> statement-breakpoint
UPDATE "protocol_versions" SET "org_id" = '00000000-0000-0000-0000-0000000000a1' WHERE "org_id" IS NULL;--> statement-breakpoint
UPDATE "protocols" SET "org_id" = '00000000-0000-0000-0000-0000000000a1' WHERE "org_id" IS NULL;--> statement-breakpoint
UPDATE "shadow_runs" SET "org_id" = '00000000-0000-0000-0000-0000000000a1' WHERE "org_id" IS NULL;--> statement-breakpoint
UPDATE "users" SET "org_id" = '00000000-0000-0000-0000-0000000000a1' WHERE "org_id" IS NULL;--> statement-breakpoint

ALTER TABLE "acknowledgments" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "demo_runs" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "protocol_versions" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "protocols" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "shadow_runs" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. Foreign keys (safe now that no NULLs remain).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "acknowledgments" ADD CONSTRAINT "acknowledgments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_runs" ADD CONSTRAINT "demo_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocol_versions" ADD CONSTRAINT "protocol_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocols" ADD CONSTRAINT "protocols_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_runs" ADD CONSTRAINT "shadow_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 4. Indexes. The unique ones below MUST be widened: left deployment-wide, the first org to open
--    a heparin case or write a heparin protocol would own that key forever and every other
--    hospital's insert would fail on a constraint that has nothing to do with them.
--
--    Four unique indexes were audited and deliberately LEFT ALONE — see `schema.ts` for the full
--    reasoning: `users_oidc_subject_uq` (one IdP subject must resolve to exactly one user, since
--    the OIDC callback carries no org), `api_keys_key_hash_uq` (one secret must authenticate as
--    exactly one tenant, and the lookup happens before any org is known), and
--    `protocol_versions_uq` / `acknowledgments_case_step_uq` (already pinned to one org through a
--    globally unique uuid, so prefixing org_id would WEAKEN them).
-- ---------------------------------------------------------------------------------------------
DROP INDEX "audit_ts_idx";--> statement-breakpoint
DROP INDEX "audit_case_action_uq";--> statement-breakpoint
DROP INDEX "cases_workflow_id_uq";--> statement-breakpoint
DROP INDEX "cases_status_idx";--> statement-breakpoint
DROP INDEX "cases_key_idx";--> statement-breakpoint
DROP INDEX "demo_runs_started_at_idx";--> statement-breakpoint
DROP INDEX "protocols_key_uq";--> statement-breakpoint
DROP INDEX "protocols_class_idx";--> statement-breakpoint
DROP INDEX "shadow_runs_key_idx";--> statement-breakpoint
DROP INDEX "shadow_runs_class_idx";--> statement-breakpoint
DROP INDEX "shadow_runs_ran_at_idx";--> statement-breakpoint
CREATE INDEX "acknowledgments_org_idx" ON "acknowledgments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "protocol_versions_org_idx" ON "protocol_versions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "users_org_idx" ON "users" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "audit_ts_idx" ON "audit_log" USING btree ("org_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_case_action_uq" ON "audit_log" USING btree ("org_id","case_id","event_key","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cases_workflow_id_uq" ON "cases" USING btree ("org_id","workflow_id");--> statement-breakpoint
CREATE INDEX "cases_status_idx" ON "cases" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "cases_key_idx" ON "cases" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "demo_runs_started_at_idx" ON "demo_runs" USING btree ("org_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "protocols_key_uq" ON "protocols" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "protocols_class_idx" ON "protocols" USING btree ("org_id","drug_class");--> statement-breakpoint
CREATE INDEX "shadow_runs_key_idx" ON "shadow_runs" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "shadow_runs_class_idx" ON "shadow_runs" USING btree ("org_id","drug_class");--> statement-breakpoint
CREATE INDEX "shadow_runs_ran_at_idx" ON "shadow_runs" USING btree ("org_id","ran_at");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 5a. The maintenance role.
--
-- Some work is legitimately cross-tenant: this migration itself, the hourly audit anchoring (it
-- pins `max(audit_log.id)`, a sequence shared by every org), the chain-verification CLI, and
-- backups. Those run as `stopgap_maintenance`, a NOLOGIN role holding BYPASSRLS that an operator
-- grants to the specific account doing the work.
--
-- Named explicitly rather than left to superuser on purpose. "Run it as postgres" is how RLS
-- quietly stops being enforced anywhere: a superuser bypasses every policy unconditionally —
-- FORCE ROW LEVEL SECURITY does not apply to it — so a deployment whose application connects as
-- a superuser has the policies below installed and doing nothing at all. Making the bypass a
-- named, grantable role means the privilege shows up in `\du`, can be audited, and can be revoked.
--
-- OPERATOR REQUIREMENT, stated plainly: the application's own database user must be NEITHER a
-- superuser NOR a member of this role. See `docs/multi-tenancy.md`. The default compose stack
-- connects as `stopgap`, which the postgres image creates as a superuser — tolerable for local
-- development, NOT acceptable for a real deployment, and the reason that document exists.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stopgap_maintenance') THEN
    CREATE ROLE "stopgap_maintenance" NOLOGIN BYPASSRLS;
  END IF;
END
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 5b. Row-level security on every tenant table.
--
-- Each table gets the same three statements, and each one earns its place:
--
--   ENABLE ROW LEVEL SECURITY  — turns policies on for ordinary roles.
--
--   FORCE ROW LEVEL SECURITY   — ESSENTIAL, not belt-and-braces. Without FORCE, the table's OWNER
--                                is exempt from every policy, and the owner is exactly who the
--                                application connects as in this compose stack (one role creates
--                                the schema and serves the app). Enabling RLS without FORCE would
--                                install policies that the only connection in the system ignores:
--                                isolation as theatre, complete with green tests, right up until
--                                someone actually checks. FORCE removes the owner exemption.
--
--   CREATE POLICY ... USING (org_id = current_setting('app.current_org', true)::uuid)
--                              WITH CHECK (same)
--                              — USING filters what a statement may SEE (and therefore what it
--                                may update or delete); WITH CHECK constrains what it may WRITE,
--                                so an INSERT or UPDATE carrying a FOREIGN org_id is rejected
--                                outright rather than silently vanishing from the writer's own
--                                view.
--
-- The TWO-ARGUMENT form `current_setting('app.current_org', true)` is deliberate. With one
-- argument, an unset variable RAISES, and every query on an unscoped connection would blow up
-- with a confusing error. With `missing_ok => true` it returns NULL instead — and NULL is the
-- whole point: `org_id = NULL` evaluates to NULL, NULL is not TRUE, so the row is invisible. An
-- unscoped connection therefore sees NOTHING rather than EVERYTHING. That is the correct
-- fail-closed direction: forgetting to scope a connection produces an empty page (a bug someone
-- reports on day one) instead of another hospital's patient data (a breach nobody notices).
--
-- CONSEQUENCE WORTH STATING: this makes the two identity-resolution lookups — `getUserByOidc`
-- (sign-in) and `findActiveApiKeyByPlaintext` (REST auth) — cross-tenant operations by nature.
-- They run BEFORE any org is known, because the org is what they return. They must therefore run
-- on the BYPASSRLS connection. Wiring that second pool is pass-2 work; it is written down in
-- `docs/multi-tenancy.md` so it cannot be discovered by surprise.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cases_org_isolation" ON "cases"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);--> statement-breakpoint

ALTER TABLE "protocols" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "protocols" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "protocols_org_isolation" ON "protocols"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);--> statement-breakpoint

ALTER TABLE "protocol_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "protocol_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "protocol_versions_org_isolation" ON "protocol_versions"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);--> statement-breakpoint

ALTER TABLE "shadow_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shadow_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "shadow_runs_org_isolation" ON "shadow_runs"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);--> statement-breakpoint

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "audit_log_org_isolation" ON "audit_log"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);--> statement-breakpoint

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "users_org_isolation" ON "users"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);--> statement-breakpoint

ALTER TABLE "demo_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "demo_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "demo_runs_org_isolation" ON "demo_runs"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);--> statement-breakpoint

ALTER TABLE "acknowledgments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "acknowledgments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "acknowledgments_org_isolation" ON "acknowledgments"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);--> statement-breakpoint

ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "api_keys_org_isolation" ON "api_keys"
  USING ("org_id" = current_setting('app.current_org', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org', true)::uuid);
