# 17 — Administrator dashboard

PR batch: C

**What to build:** The administrator's operations surface. They land on what still needs configuring and whether the system is healthy. From here they load and inspect the facility's catalog, see which items are sole-sourced, check whether any data feed has gone quiet, and manage the access that everything else depends on.

**Blocked by:** 03, 15, 16

**Status:** DONE — batch C (#37) shipped every criterion but connector health, which landed on
`feat/programme-closeout` with migration 0022. Configurable spend caps are closed by decision, below.

**Verification receipt (red before green)** for the connector-health criterion.
`packages/db/src/rls.e2e.test.ts` gained `connector_runs` to its `TENANT_TABLES` probe list and its
fixture before the table existed, and was run against the schema as it stood:

```text
FAIL packages/db/src/rls.e2e.test.ts
PostgresError: relation "connector_runs" does not exist
      Tests  200 skipped (200)
```

After migration 0022 the tier is green at 249 (was 241): the eight new tests are the four
cross-tenant probes — SELECT, INSERT `WITH CHECK`, UPDATE, DELETE — plus the unscoped and
recycled-connection reads, run for the new table.

- [x] The administrator lands on a setup checklist and system health
- [x] Catalog files can be uploaded from the dashboard, with per-row failures shown clearly enough to correct the file
- [x] The catalog can be browsed and searched, with list state carried in the page address
- [x] An item detail view shows its identifiers, suppliers, inventory position and any signals matched to it
- [x] Sole-sourced items are identifiable
- [x] Connector health and last-run time are visible, so a silent feed is noticed
- [x] Existing user, role, API key and organization management remain reachable and unchanged in behaviour
- [ ] Model spend caps are configurable — **closed by decision**, see below
- [x] A demo workspace containing no real facility data can be seeded

## Connector health — why it needed a table rather than a query

The dashboard already had a feed panel, but it read `feed_records`, which is a GLOBAL table: one
openFDA snapshot is one physical fact about the drug supply, stored once for the whole deployment.
That panel could therefore say the deployment had heard from openFDA. It could not say whether THIS
hospital got signals out of that poll, and it could say nothing at all about the recall connectors,
which normalize straight onto the signal contract and store no feed record.

`connector_runs` is the per-tenant half: one row per `(org_id, source)`, upserted with the latest
run, carrying the outcome, this tenant's signal count, and the failure text when there was one. It
is bounded at tenants × feeds, which is why it is a latest-run row rather than a run log — a growing
history would have needed a retention window to answer a question that only ever asks about the last
run.

Two timestamps, deliberately: `ran_at` is the last ATTEMPT and moves whether or not it worked;
`last_ok_at` only moves on success. A connector failing every poll for a week has a recent `ran_at`
and a stale `last_ok_at`, and that gap is the whole signal.

The console lists every source in `SIGNAL_SOURCES`, not only the ones with a row — a connector that
has never run for this facility has nothing stored, and rendering only what is stored would drop it
from the table entirely, which reads identically to a connector that is fine.

## Model spend caps — closed by decision, not deferred

Asked and answered on 2026-07-30: **do not build it.**

`LLM_DAILY_USD_CAP` is deployment environment. The cap binds every process in the deployment — a
scheduled poll spends the same dollars a visitor does — so a per-tenant console control would let
one hospital lift a limit that binds every other hospital on the same deployment. That is a
cross-tenant authorization hole wearing a settings form, and it is why this criterion was never
implemented as written rather than merely postponed.

Done correctly it is a DEPLOYMENT-scoped setting with its own table, its own migration and an
admin-only write path — a different feature from the one the criterion describes, and out of scope
for this programme.

What ships instead: the setup checklist states the cap, its value, today's spend against it, and in
plain words why it is not editable here (`apps/console/app/(admin)/admin/page.tsx`). An
administrator is told the state and the reason rather than shown a control that would be unsafe.
