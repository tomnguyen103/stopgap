-- Drop any duplicate (case_id, action) rows accumulated before this migration (e.g. from
-- Temporal activity retries that double-appended prior to the appendAudit idempotency fix),
-- keeping the earliest row per pair so the chain's first occurrence of each event survives.
DELETE FROM "audit_log" a
USING "audit_log" b
WHERE a.case_id = b.case_id
  AND a.action = b.action
  AND a.case_id IS NOT NULL
  AND a.id > b.id;
--> statement-breakpoint
CREATE UNIQUE INDEX "audit_case_action_uq" ON "audit_log" USING btree ("case_id","action");
