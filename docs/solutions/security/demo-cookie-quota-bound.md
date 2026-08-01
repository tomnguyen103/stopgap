# Anonymous demo cookie churn needed an aggregate bound

## Symptom

The public demo stored a server-issued visitor UUID in an httpOnly cookie and counted accepted
shortage starts per `(org_id, visitor_id)`. That preserved a fair per-visitor hourly quota, but a
caller could delete the cookie before each request. If `LLM_DAILY_USD_CAP` was unset and the
provider preference was a paid model, cookie churn could create unbounded paid-provider attempts.

## Root cause

The cookie was only a quota key, not an identity credential. Treating the per-cookie count as the
only limiter made a client-resettable value the sole spend guard. The optional daily cap was not a
safe prerequisite because deployments are allowed to leave it unset.

## Fix

`packages/core/src/env.ts:101-104` now defines `DEMO_MAX_RUNS_PER_HOUR_TOTAL` with a default of 60.
`packages/db/src/demo-runs.ts:35-83` reserves a slot under one per-demo-tenant advisory lock and
checks both the visitor count and the aggregate tenant count before inserting the durable attempt
row. `packages/demo/src/scenario.ts:17-90` passes both limits through and explains the two bounds
to the caller. The cookie remains useful for per-visitor fairness, while cookie deletion cannot
exceed the aggregate hourly guard.

## Regression coverage

`packages/demo/src/demo.test.ts:98-126` verifies the default and configured aggregate limits are
passed to the atomic reservation. The full `pnpm gate` and RLS suite are the delivery gates for the
database-backed reservation.
