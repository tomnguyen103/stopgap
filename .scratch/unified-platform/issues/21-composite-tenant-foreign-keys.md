# 21 — Composite tenant foreign keys, everywhere a tenant row points at another

**What to build:** Every foreign key between two tenant tables names the `(org_id, id)` PAIR, not the child id alone, so a row filed under one hospital cannot point at another hospital's row.

A plain foreign key proves the parent exists; it does not prove it belongs to this tenant. The referential check runs with row-level security bypassed, and `org_id` is written by the calling function, so a row naming another tenant's parent passes both the foreign key and the policy's `WITH CHECK` and lands. Requiring the pair to match makes that unrepresentable in the database instead of a rule every future caller has to remember.

Three tables already do this and are the pattern to copy: `risk_score_snapshots` and `signal_evidence` reference `risk_signals (org_id, id)`, and `alert_events` references `alert_rules (org_id, id)`. Each needs a unique constraint over exactly the referenced pair on the parent — `risk_signals_org_id_uq` is that constraint, and it exists solely to make the pair a legal foreign-key target.

What is still plain: `acknowledgments.case_id` and `audit_log.case_id` both reference `cases.id` on its own. Both are tenant tables carrying their own `org_id`, so both can currently hold a row whose org and whose case disagree.

**Blocked by:** nothing technically — but it adds a migration, and every branch in the ticket queue already carries one. Land it after tickets 01–20 have merged, so the numbering is settled and the schema merge is against a quiet main.

**Status:** DONE — `feat/ticket-21-composite-fks`, migration `0021_yielding_impossible_man.sql`.

**Verification receipt (red before green).** `packages/db/src/tenant-keys.e2e.test.ts` was written
first and run against the schema as it stood:

```text
× refuses an acknowledgment of another tenant's case
  → promise resolved "[]" instead of rejecting
```

Every cross-tenant probe failed that way — the inserts LANDED — while the control ("still accepts
the same row when both sides are the caller's own") passed, which is what rules out a suite that
merely refuses everything. After the migration the suite is green at 17 tests: 14 probes, one per
composite key, plus the control, the `SET NULL` behaviour, and a completeness check that asks
`pg_constraint` which composite keys exist and fails if the probe list does not match it.
Whole tier `pnpm test:rls` 236 passed; `pnpm gate` green.

Pre-flight against this deployment's data found ZERO rows already violating any of the fourteen pairs.

- [x] `cases` gains a unique constraint over `(org_id, id)`, with the same note the one on `risk_signals` carries: redundant as an index, required by Postgres before the pair can be a foreign-key target
- [x] `acknowledgments` and `audit_log` reference `cases (org_id, id)` as a composite foreign key, replacing the plain reference to `cases.id`
- [x] The delete behaviour of each converted key is stated deliberately rather than inherited — an audit entry must not disappear because a case did
- [x] Any tenant table landing from the catalog and matching tickets follows the same rule, including rows that reference `risk_signals`
- [x] Isolation coverage proves the database REFUSES a row whose `org_id` and parent disagree, running as the application role the policies apply to — not as the owner, which bypasses them
- [x] The migration applies cleanly as the role a real deployment migrates as, and against existing data: check first whether any row already violates the pair, and say what was found
- [x] The reasoning is recorded beside each converted key, in the form the three existing composite keys already use

## What the ticket did not anticipate

- `protocol_versions` has TWO tenant-to-tenant keys the ticket does not mention — `protocol_id` and
  `source_case_id`. The second is the exact shape bullet 4 describes, and it was missed on the first
  pass; the local review's spec axis caught it. Fourteen keys in total, not two.
- The catalog children (bullet 4) are ten of those, not a footnote: `item_identifiers`,
  `supplier_sites`, `item_suppliers` (three), `inventory_snapshots` (two) and
  `procurement_events` (three). Their parents needed the `(org_id, id)` constraint too.
- Two of those keys are `ON DELETE SET NULL`, which on a composite nulls EVERY referencing
  column — including `org_id`, which is NOT NULL. The generated DDL would have created
  cleanly and thrown the first time somebody deleted a supplier or a site. Migration 0021
  hand-writes Postgres 15+'s `SET NULL (column)` form, and a test deletes a site to pin it,
  because nothing else would have caught it before production.
- `drizzle-kit` emitted every `ADD CONSTRAINT` before the unique indexes they target, which
  Postgres refuses outright. The migration is reordered by hand.
