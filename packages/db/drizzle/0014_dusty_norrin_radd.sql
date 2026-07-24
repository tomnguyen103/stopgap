-- PHASE6 §6.5 pass 2 — per-org audit anchoring, and the second seeded organization.
--
-- HAND-WRITTEN (not `drizzle-kit generate` output), for the same reason 0013 was: drizzle can
-- express the column and the index, but not the backfill order that makes the change runnable
-- against a database that already has rows in it, and not the seed insert.
--
-- Additive throughout. Nothing is dropped, nothing is deleted, and no existing value changes
-- except `audit_anchors.org_id`, which goes from "did not exist" to "the seed org".
--
-- ---------------------------------------------------------------------------------------------
-- 1. audit_anchors.org_id — NULLABLE -> backfill -> NOT NULL.
-- ---------------------------------------------------------------------------------------------
-- WHY THIS COLUMN EXISTS. Migration 0013 made the audit chain PER-ORG: each tenant's rows chain
-- from their own genesis, and `verifyAuditChain(db, orgId)` verifies one tenant. It left
-- `audit_anchors` global, which was a mistake we are correcting here rather than living with. An
-- anchor pins a `(max_audit_id, head_hash)` pair — but with N chains there is no longer "the head
-- hash", so a global anchor pins whichever tenant happened to append last, and `verifyAnchors`
-- then compares that hash against a chain it may not belong to. The result is either a mismatch
-- that is not tampering, or a match that says nothing about the org whose history was actually
-- rewritten. Neither is an integrity check.
--
-- Nullable-then-backfill-then-NOT-NULL for the reason 0013 used the same dance: adding a NOT NULL
-- column outright fails on any non-empty table, and `audit_anchors` is non-empty on every
-- deployment that has run the hourly anchoring schedule for an hour.
ALTER TABLE "audit_anchors" ADD COLUMN "org_id" uuid;--> statement-breakpoint

-- Every pre-existing anchor was taken when exactly one tenant existed — the one 0013 backfilled
-- all historical rows into. Attributing them to the seed org is therefore a statement of fact, not
-- a default. Note what this does NOT touch: `head_hash` and `max_audit_id` are left exactly as
-- written, so every anchor still pins the same bytes it always did and re-verification against the
-- external anchor file continues to hold.
UPDATE "audit_anchors" SET "org_id" = '00000000-0000-0000-0000-0000000000a1' WHERE "org_id" IS NULL;--> statement-breakpoint

ALTER TABLE "audit_anchors" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "audit_anchors" ADD CONSTRAINT "audit_anchors_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Verification reads anchors newest-first for ONE org, so the org column leads: without this a
-- per-tenant integrity check walks every other tenant's anchors before discarding them.
CREATE INDEX "audit_anchors_org_idx" ON "audit_anchors" USING btree ("org_id","id");--> statement-breakpoint

-- ROW-LEVEL SECURITY ON audit_anchors: SELECT-ONLY, scoped to the tenant.
--
-- 0013 left this table with no policy at all, justified as "a tenant must not be able to stop its
-- own history being anchored". That justification only ever covered the WRITE side, and the absence
-- of a policy is not write-only: with RLS disabled, an ordinary org-scoped connection could UPDATE
-- or DELETE every OTHER tenant's anchor rows, and read all of them. `verifyAnchors`'s explicit
-- `org_id` filter was the only thing between a tenant and every other tenant's integrity metadata —
-- an application predicate standing in for a database guarantee, which is precisely the arrangement
-- §6.5 exists to replace.
--
-- The fix keeps the original property and closes the hole, by granting exactly one verb:
--   * a USING policy for SELECT, keyed to `app.current_org` like every other tenant table, so an
--     org sees the anchors pinning its own chain and no others;
--   * NO policy for INSERT, UPDATE or DELETE. With RLS enabled and no permissive policy for a
--     command, that command matches nothing and is refused — so a tenant cannot delete, rewrite or
--     forge an anchor, which is the "cannot opt out of anchoring" property stated as a permission
--     rather than as an absence.
-- Anchoring itself is unaffected: it runs on the maintenance connection (`DATABASE_URL_MAINTENANCE`,
-- a BYPASSRLS role), to which no policy applies.
--
-- FORCE for the same reason as every other table: without it the table OWNER is exempt, and the
-- owner is who a single-role stack connects as.
ALTER TABLE "audit_anchors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_anchors" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "audit_anchors_org_read" ON "audit_anchors"
  FOR SELECT
  USING ("org_id" = current_setting('app.current_org', true)::uuid);--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 1b. (org_id, key) on `cases` becomes UNIQUE.
-- ---------------------------------------------------------------------------------------------
-- This pair is the identity the application already treats a case by: `getCaseByKey` is the only
-- sanctioned way to find a case from a shortage key, and `upsertCaseForRecord` decides whether an
-- org already has a case for a drug by reading it. Both were relying on a NON-unique index plus the
-- convention that the upsert checks before inserting — so two concurrent detections could interleave
-- their check and their insert, leave one org holding two cases for one drug, and then
-- `getCaseByKey`'s `.limit(1)` (no ORDER BY) would return whichever row the planner emitted first,
-- flipping between page loads.
--
-- SAFE AGAINST EXISTING DATA, which is why this is a unique index rather than an added ORDER BY:
-- before 0013 `cases_workflow_id_uq` was unique on `workflow_id` alone and `workflow_id` was
-- `case-<key>`, a pure function of the key — so a duplicate `(org_id, key)` could not have been
-- written in the first place. If this statement DOES fail on some deployment, that is a real
-- duplicate that must be reconciled by hand before the constraint can hold; failing here is the
-- correct outcome, not something to work around with a looser index.
--
-- The old non-unique index is dropped rather than kept: it is a strict prefix-equal duplicate of the
-- new one, so keeping it would only cost writes.
DROP INDEX IF EXISTS "cases_key_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "cases_key_uq" ON "cases" USING btree ("org_id","key");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. The second organization.
-- ---------------------------------------------------------------------------------------------
-- §6.5's acceptance is "two seeded orgs run side by side; cases, protocols, shadow, audit fully
-- disjoint". One tenant cannot demonstrate isolation: every query returns the same rows whether or
-- not the policies work. A second tenant is what makes the claim falsifiable.
--
-- The row is created HERE rather than only in the demo seeder (`packages/demo/src/seed.ts`, which
-- does fill both orgs with content) because that seeder refuses to run unless
-- `STOPGAP_DEMO_MODE=on` — its cases are fiction and must never sit beside real shortages a
-- pharmacist has to act on. An empty organization is NOT fiction; it is an isolation boundary with
-- no data in it. Creating it unconditionally means a plain `pnpm db:migrate` already yields the
-- two tenants the acceptance asks for, and the demo seeder's job is only to give them something to
-- look at.
--
-- Fixed id (`SECOND_ORG_ID` in packages/db/src/orgs.ts) for the same reason the seed org's is
-- fixed: application code names the same tenant in every deployment without a lookup, and a dump
-- from one machine stays readable on another. ON CONFLICT DO NOTHING keeps the statement
-- idempotent against a database where it was seeded by hand first.
INSERT INTO "organizations" ("id", "slug", "name")
VALUES ('00000000-0000-0000-0000-0000000000a2', 'riverside', 'Riverside General (second seeded organization)')
ON CONFLICT ("id") DO NOTHING;
