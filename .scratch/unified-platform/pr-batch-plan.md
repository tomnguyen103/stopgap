# PR batch plan — collapses the 12-PR queue to 3

Decided 2026-07-29. The inherited one-ticket-one-PR queue was 12 PRs / ~50k changed
lines, which is 12 CodeRabbit reviews before any fix round against an adaptive
fair-usage budget of roughly 3-5 completed reviews per day. Batching to 3 saves nine
review events. Merge order is A -> B -> C, which the dependencies force anyway.

## Batch A — data and backend  (~15k lines)
Base branch: `feat/catalog-schema-and-csv-import`, PR #15 RETITLED as the batch PR.
Order: 15 (already on the branch) -> 32 -> 26 -> 27 -> 13.

| Ticket | Old PR | Branch |
| --- | --- | --- |
| 15 catalog schema + CSV import | #15 (reused) | feat/catalog-schema-and-csv-import |
| 16 matching + score completion | #32 (close) | feat/matching-and-score-completion |
| 19 public API signals/scores/catalog | #26 (close) | feat/public-api-signals-scores-catalog |
| 18 retention schedule | #27 (close) | feat/retention-schedule |
| 10 compliance guard | #13 (close) | feat/compliance-guard |

## Batch B — console foundation and first dashboards  (~17k lines)
New branch off merged main. Order: 16 -> 21 -> 24 -> 28 -> 29.

| Ticket | Old PR | Branch |
| --- | --- | --- |
| 02 design tokens + primitives | #16 (close) | feat/design-tokens-and-primitives |
| 03 route groups + role landing | #21 (close) | feat/route-groups-and-role-landing |
| 04 browser smoke tier | #24 (close) | feat/browser-smoke-tier |
| 08 viewer dashboard | #28 (close) | feat/viewer-dashboard |
| 11 pharmacist dashboard | #29 (close) | feat/pharmacist-dashboard |

## Batch C — remaining dashboards  (~18k lines)
New branch off merged main. Order: 14 -> 17.

| Ticket | Old PR | Branch |
| --- | --- | --- |
| 14 director dashboard | #30 (close) | feat/director-dashboard |
| 17 admin dashboard | #33 (close) | feat/admin-dashboard |

## Rules that bind the assembly

- Every branch carries its own migration. Cherry-pick the code, DROP each branch's
  migration artifacts, then regenerate ONE migration per batch at the end, with any
  hand-authored SQL (RLS policies) re-applied on top. Never a rename.
- One `pnpm gate` and one `mattpocock-skills:code-review` per BATCH, not per ticket.
- One ready flip per batch. That flip is the only review-spending event for the batch.
- Batch C's `feat/director-dashboard` still owes the `assertRuleVocabulary` fix in
  `packages/db/src/alerts.ts` (the update path must consult the STORED webhook, not the
  input). Apply it in C's assembly, after the cherry-picks, never before.
- Ticket 21 (composite tenant foreign keys) stays AFTER all three batches.

## Batch A assembly — exact commits (established 2026-07-29 21:2xZ)

Base: `feat/catalog-schema-and-csv-import` @ `9e522d5` (already rebased onto main,
migration regenerated at 0020, local review done, force-pushed).

Cherry-pick IN THIS ORDER. Each branch's OWN commits only — the lists below are already
filtered, because several of these branches carry other branches' history wholesale.

1. ticket 16 (#32): `b6793ad` `00600ed` `e8146b3`
2. ticket 19 (#26): `e21fc6a` `c0fef2b`
3. ticket 18 (#27): `e06efb8` `a515647` `3586094`
4. ticket 10 (#13): `770a58f` `c25071b`  -- VERIFY FIRST, see below

### Traps found while reading the branches

- `feat/retention-schedule` is NOT a ticket-18 branch. Its merge-base with main is far
  back and it carries the admin, director, pharmacist and viewer dashboards, the brief,
  compliance, alerts, evidence, scorer, route groups and tokens work as ancestors. Only
  the three commits listed above are its own. Never `git log <merge-base>..` it and treat
  the output as the ticket.
- `5431d01 docs: the absorption record (ticket 20)` sits in that branch and is
  DELIBERATELY EXCLUDED: `docs/absorption.md` stays an unlanded draft (locked decision).
- `feat/compliance-guard` (#13) is `770a58f` + `c25071b`, where `c25071b` is the
  medical_record_number label-boundary fix from the spawned side-session. BUT #31 already
  merged `packages/compliance` and the comms screening to main, which is ticket 10's
  deliverable. Check what of `770a58f` is still absent from main before picking it; it may
  reduce to `c25071b` alone.
- Every one of these branches carries its own migration. Drop them all during the picks
  and regenerate ONE migration for batch A at the end, RLS re-applied on top.

### RESOLVED: ticket 10 (#13) reduces to ONE commit

`packages/compliance` and the comms outbound screening are ALREADY ON MAIN — they landed
inside #31 (ticket 13). `git diff main origin/feat/compliance-guard -- packages/compliance
packages/comms` is +22/-276: main is strictly ahead, and picking `770a58f` would REMOVE
work main already has. Do not pick it.

The only thing #13 still contributes is `c25071b` — the `medical_record_number` label
boundary fix. Main's rule at `packages/compliance/src/index.ts:104` is still the buggy
form `/\b(?:MRN|medical record (?:number|no\.?|#))\b[\s:#-]*.../` where the boundary sits
AFTER the alternation and so can never hold following `no.` or `#`. `c25071b` moves the
boundary inside each alternative, exactly as `national_identifier` was fixed on #31.

So batch A step 4 is: cherry-pick `c25071b` alone, then close #13 noting ticket 10 landed
via #31 and only the label fix remained.

## STATE 2026-07-29 ~21:5xZ

Batch A ASSEMBLED and pushed. Branch `feat/catalog-schema-and-csv-import` head `3c01098`,
16 commits over main, one migration (0020), `pnpm gate` exit 0. Tickets 15, 16, 19, 18, 10.
No schema drift beyond 0020 — 16/19/18 read and sweep existing columns, drizzle-kit says
"No schema changes".

Remaining for batch A: local review over the whole batch diff -> fix -> retitle #15 ->
close #32 #26 #27 #13 as superseded -> ready flip (the ONE review event) -> wait protocol
-> merge. Last completed CodeRabbit review was 20:01:34Z, so the flip waits until ~22:16Z.

## Batch A standards review — open findings at 22:05Z (head c45aeb6)

Scoring-pass merge verified CORRECT (scores once, evidence + alert pairing intact, no
use-before-assignment). Migration 0020, db/src/index.ts exports, PROGRESS.md union,
lockfile, schedule wiring, all four API routes: verified clean.

TO FIX before the ready flip:
7. `activities.ts` degraded catalog path returns `{matchedItems:0,soleSourcedItems:0}` —
   but `impact.ts` already ships `NO_CATALOG_DATA = {}` and states "a fabricated zero is
   not distinguishable from a measured one". `affectedFormularyItems` then republishes the
   fake 0 as measured. Root cause: `ImpactResult.affectedFormularyItems` non-optional in
   `shared.ts:103`. THIS IS A REGRESSION I INTRODUCED in c45aeb6.
9. `retention.ts:212` awaited `appendAudit` in `finally` REPLACES the original sweep error.
8. `retention.ts:210` `counts[kind] = await sweepKind(...)` — a throw after committed
   batches records 0 for a kind that removed thousands.
10. `sweepKind`'s `for(;;)` never heartbeats; one beat per tenant against a 5-min
    heartbeatTimeout means one large tenant exhausts maximumAttempts.
4. `activities.tenancy.test.ts` `sweptOrgs` is the only recorder `beforeEach` never resets;
   the assertion passes only because it is first in file order.
6. `workflows/src/index.ts` does not re-export `retentionSweepWorkflow` /
   `RETENTION_SWEEP_WORKFLOW` — the only workflow/name pair missing.
5. `workflow.test.ts` gained a `sweepRetention` mock but no delegation describe, so the
   new workflow has zero workflow-level coverage.
1. `docs/multi-tenancy.md:482,489` still say "A third live suite" / "the two suites above";
   there are six.
2. `docs/multi-tenancy.md:31` tenant row omits `alert_rules`/`alert_events`.
3. `docs/observability.md` missing `stopgap_catalog_match_failures_total` and
   `stopgap_catalog_read_failures_total`.

DEFERRED with reasons: 11 (retention predicate unindexed for 4 of 5 kinds) and 13
(count(*) + ILIKE per page view) are performance work that adds indexes = a migration;
ticket 21 already carries this batch's next migration. 14/15/16/17/18 are low-severity or
judgement calls. Ticket 10 plural `numbers` nit not fixed.

## Batch A PARKED 22:23:30Z

Ready flip at 22:20:23Z on head `5d5463a` was REFUSED: `state: success`,
`description: Review rate limited`. That refusal is now the LAST SPENT EVENT — time the
next trigger from 22:23:30Z, not from the 20:01:34Z completion.

NEW DATA POINT for the budget model: 2h19m after a COMPLETED review was still not enough.
The previous session's note said "allow well over an hour, 2-3h after a completed review";
this refusal shows 2h19m sits inside the window. Next attempt should allow appreciably
longer — treat 3h+ from the last SPENT event (22:23:30Z, so ~01:30Z) as the floor, and
remember each refusal pushes the window further out.

Batch A state at park: head `5d5463a`, 19 commits over main, one migration (0020), gate
exit 0, both local review axes clean, PR retitled, #32/#26/#27/#13 closed as superseded.
Every finding from both review agents is fixed except the ones recorded as DEFERRED above.
