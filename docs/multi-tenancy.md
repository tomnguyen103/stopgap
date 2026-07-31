# Multi-tenancy and row-level security (Phase 6 §6.5)

Stopgap is deployable across a health system's facilities: each hospital is an **organization**,
and no organization can read or write another's data. Isolation is enforced in **Postgres**, by
row-level security policies, not by remembering to write a `WHERE` clause. An application-layer
bug is then a bug, not a breach.

Both passes have landed. Pass 1 built the data layer — `organizations`, `org_id` on every tenant
table, the RLS policies, `withOrgDb`/`withBypassDb`, and the per-org audit chain. Pass 2 threaded a
real org through every call site: the console session, the API key, and the workflow input.

**Where an org comes from — three sources, and there is no fourth.**

| Caller | Source of the org | Enforced in |
| --- | --- | --- |
| Console request | the signed-in user's `users.org_id`, carried on the Auth.js session | `apps/console/app/lib/principal.ts` |
| REST / MCP request | `api_keys.org_id` of the presented key | `apps/console/app/lib/api-auth.ts` |
| Workflow / worker | `CaseInput.orgId`, fixed when the case was opened | `packages/workflows/src/shared.ts` |

The scheduled feed poll is the one path with none of the three, and it does not invent one: it
enumerates `listOrganizations()` and does a full pass of its work inside `withOrgDb(org.id, …)` per
tenant. See "The feed poll" below.

## The model

`organizations` is the tenant registry — `id`, `slug`, `name`. Every **tenant** table carries an
`org_id` FK to it and an RLS policy keyed to it — and, where it points at another tenant table, a
composite foreign key naming the `(org_id, id)` PAIR rather than the id alone (ticket 21). The two
are not redundant. RLS decides which rows a session may SEE; the referential check runs with RLS
bypassed and reads `org_id` as the calling function wrote it, so a row carrying the caller's own
`org_id` and another tenant's parent id satisfied both the policy's `WITH CHECK` and a plain foreign
key, and landed. Only the pair refuses it. Each such parent therefore also carries a
`(org_id, id)` unique constraint — redundant as an index, required by Postgres before the pair can
be a foreign-key target.

The one exemption is a reference to `users`: the synthetic `system` and `agent` principals live in
the seed org and are named from every tenant's rows by design, so those keys stay plain. It is
recorded at `acknowledgments.userId` in `packages/db/src/schema.ts` so a reader can tell "considered
and exempt" from "missed".

ADDING A TENANT CHILD TABLE IS FOUR EDITS, not one: the parent's `(org_id, id)` unique index, the
composite key on the child, a branch in the migration's pre-flight violation check, and a probe in
`tenant-keys.e2e.test.ts`.

That suite asks `pg_constraint` which composite keys exist and fails if its own probe list does not
match — but it asks about a FIXED SET OF TABLES, named in the query. So it catches a key added to a
table it already knows about, and it does NOT catch a brand-new table nobody added to the query.
The check is a guard on the tables in it, not a discovery mechanism, and the fourth edit is
enforced only to that extent. Adding a table means adding it to the query too, which is the fifth
edit hiding inside the fourth.

| Tenant tables (RLS enforced) | Global tables (no `org_id`) |
| --- | --- |
| `cases`, `protocols`, `protocol_versions`, `shadow_runs`, `audit_log`, `users`, `demo_runs`, `acknowledgments`, `api_keys`, `risk_signals`, `risk_score_snapshots`, `signal_evidence`, `daily_briefs`, `alert_rules`, `alert_events`, `items`, `item_identifiers`, `suppliers`, `supplier_sites`, `item_suppliers`, `facilities`, `inventory_snapshots`, `procurement_events`, `audit_anchors` (asymmetric: SELECT only — see below) | `feed_records`, `llm_spend`, `escalation_policies`, `user_roles`, `api_key_requests`, `organizations` |

`risk_signals` and `risk_score_snapshots` (ticket 06) are the sharpest illustration of the test.
`feed_records` beside them is GLOBAL: one openFDA snapshot is a single physical fact about the drug
supply, byte-identical for every hospital. A risk signal is that fact interpreted for one facility —
its own org-scoped dedupe key, its own resolution state, its own weighting — so two hospitals
reading the same recall genuinely disagree about the row, and it is tenant data.
The eight catalog tables (ticket 15, migration 0020) are tenant data by the same test as the rest:
two hospitals stocking the same drug hold different items, different suppliers, different contract
prices and different shelves. Nothing about a facility's catalog is a shared external fact.

`audit_anchors` sits between the two: migration 0014 gives it an `org_id` (so an anchor says WHOSE
chain it pins) and RLS with a deliberately **asymmetric** policy — SELECT scoped to the tenant, and
no INSERT/UPDATE/DELETE policy at all, so a tenant can read the anchors pinning its own chain but
cannot stop its own history being anchored. See "Anchoring is per-org" below.

Global is a decision per table, recorded in `packages/db/src/schema.ts` beside each one:

- **`feed_records`** — external data, not tenant data. One openFDA record is one physical fact
  about the drug supply, identical for every hospital; per-org copies would multiply the poller's
  writes by the tenant count and break the `(source, source_id)` dedup contract.
- **`llm_spend`** — a *deployment-wide* budget cap. Splitting it per org turns one hard ceiling
  into N ceilings summing to N times the budget.
- **`escalation_policies`** — per-severity config, currently shared. **A later PR may make this
  per-org**; doing it properly means widening `escalation_policies_severity_uq` to
  `(org_id, severity)` and seeding a ladder for every new org. Today every org shares one ladder.
- **`user_roles`, `api_key_requests`** — scoped *transitively* through `users` / `api_keys`. A
  second copy of `org_id` here could disagree with the first.
- **`organizations`** itself — a session must resolve its own org *before* `app.current_org` can
  be set. An isolation policy on the table that defines isolation is a chicken-and-egg with no
  exit. It holds no tenant data, only names.

## How a request gets scoped

```ts
import { withOrgDb } from "@stopgap/db";

const cases = await withOrgDb(session.orgId, (db) => listCases(db, session.orgId));
```

`withOrgDb` opens a transaction and runs `set_config('app.current_org', $1, true)` before the
callback. Every tenant query in the application now goes through it — the console's server actions
and page reads, every `/api/v1` route, every workflow activity, the demo seeder, the shadow replay
and the Prometheus scrape. The two exceptions are named below and nowhere else.

Two details carry the weight:

- **`true` = transaction-local.** The app uses a connection pool, so a connection goes straight to
  the next request when this one ends. A *session*-level setting would survive that handoff and
  the next request would inherit the previous tenant — a cross-tenant leak with no application bug
  to find. `SET LOCAL` would do the same job but cannot take a bind parameter, which is why the
  `set_config(...)` function form is used: the org id crosses the wire as data, never as
  concatenated SQL.
- **Belt and braces.** The query helpers *also* take an explicit `orgId` and keep an
  `eq(table.orgId, orgId)` predicate. RLS is the backstop that makes an app bug non-catastrophic;
  the explicit filter is what makes that bug *visible* — a query that loses its scope returns zero
  rows, which is a failing test and an empty page someone reports, rather than silence.

## The policies

Every tenant table gets, in migration `0013`:

```sql
ALTER TABLE cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases FORCE ROW LEVEL SECURITY;
CREATE POLICY cases_org_isolation ON cases
  USING (org_id = current_setting('app.current_org', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org', true)::uuid);
```

- **`FORCE` is essential, not decoration.** Without it the table **owner** is exempt from every
  policy — and the owner is exactly who the application connects as in this compose stack. RLS
  without `FORCE` is isolation as theatre: policies installed, green tests, and nothing enforced.
- **`USING` vs `WITH CHECK`** — `USING` filters what a statement may *see* (and so what it may
  update or delete); `WITH CHECK` constrains what it may *write*, so an INSERT carrying a foreign
  `org_id` is refused outright (SQLSTATE `42501`) rather than accepted and hidden.
- **`current_setting(..., true)` is fail-closed — in two different ways.** The two-argument form
  returns NULL instead of raising when the variable was never set. `org_id = NULL` is NULL, NULL is
  not TRUE, so the row is invisible: an unscoped connection sees **nothing**, not everything.

  On a **recycled** connection the mechanism differs and the outcome is louder. `set_config(...,
  true)` is transaction-local, so the value is reverted at commit — but reverted to the connection's
  *session* value, and setting a custom GUC once materialises the placeholder with the **empty
  string** as its reset value. So after any `withOrgDb`, that pooled connection reports
  `current_setting('app.current_org', true) = ''` rather than NULL, and the policies' `''::uuid`
  raises `22P02` mid-statement. `RESET app.current_org` does not undo it: it restores that same
  empty string.

  Both doors are closed — an error is not a leak, and no other tenant's row is returned either way —
  and in a pooled application the second is the common one, since only the first request a
  connection ever serves is in the never-set state. `rls.e2e.test.ts` asserts both separately rather
  than as "errors *or* returns nothing", so a change that swapped one for the other is visible. The
  policies are deliberately **not** wrapped in `nullif(current_setting(...), '')`: that would turn
  the loud outcome into the quiet one, and on the path whose job is refusing to serve data it cannot
  attribute, the crash is the better failure.

## Roles: who may bypass

Some work is legitimately cross-tenant: migrations, hourly audit anchoring, `pnpm verify-audit`,
and backups. Migration 0013 creates a named role for it:

```sql
CREATE ROLE stopgap_maintenance NOLOGIN BYPASSRLS;
```

Grant it to the account that runs those jobs. `withBypassDb` in `packages/db/src/org-context.ts`
is the only sanctioned code path that reads across tenants — named conspicuously so cross-tenant
access is greppable and obvious in a diff, instead of being what any forgotten `withOrgDb`
silently produces.

### Two connections, because RLS is a property of the ROLE

Row-level security applies to the connected role, not to the statement: there is no "ignore the
policies for this query". A deployment with ONE connection therefore has to pick which half to
break — connect as a superuser and every policy is decoration, or connect as a plain application
role and the authentication bootstrap, audit anchoring and verification all stop working (they read
across tenants by nature). Neither is a working configuration.

So there are two:

| Variable | Role | Used by |
| --- | --- | --- |
| `DATABASE_URL` | `stopgap_app` — **neither** superuser **nor** BYPASSRLS | every request, every activity, every scoped query |
| `DATABASE_URL_MAINTENANCE` | the owner / a BYPASSRLS role | `withBypassDb`: OIDC + API-key lookup, anchoring, `verify-audit`, the metrics scrape |
| (`DATABASE_URL`, owner) | the owner | migrations only — `stopgap_app` holds no CREATE right |

Both compose stacks create `stopgap_app` for you, on every `up`, via a one-shot `app-role-init`
service running `deploy/postgres/app-role.sql` (idempotent, and *not* a
`/docker-entrypoint-initdb.d` script — those only fire on a first boot with an empty volume, so they
silently skip every stack that already has data). `deploy/docker-compose.prod.yml` points the app at
`stopgap_app` and gives the maintenance url to the console, worker and seeder.

**When `DATABASE_URL_MAINTENANCE` is unset, `withBypassDb` falls back to the ordinary pool.** That
is the *single-role development configuration*, and it is correct only because the zero-config local
`DATABASE_URL` names the compose superuser, which bypasses the policies anyway. **It is not a
working production configuration** — it enforces no isolation. Nothing pretends otherwise:

- the pool logs a loud warning at startup when the application role turns out to bypass RLS;
- `/api/readyz` reports `checks.rlsEnforced` (`false` when the role bypasses, `null` when unknown).
  It is a reported condition, not a hard failure — local dev legitimately runs single-role;
- `/api/readyz` also reports `checks.maintenanceConnection`, a **separate** named check that **does
  fail readiness (503) when `NODE_ENV=production`** and there is no usable maintenance connection —
  unset `DATABASE_URL_MAINTENANCE`, unreachable, or pointed at a role that does not hold BYPASSRLS.
  The two checks are independent, which is why neither is folded into the other: a production
  deployment that omits the variable reports `rlsEnforced: true` (the policies really are applying)
  while every cross-tenant read returns zero rows, so nobody can sign in and nothing says why. In
  development the check reports its state and does not gate;
- `anchorAuditChain` and `pnpm verify-audit` call `assertMaintenanceRoleBypassesRls` and **refuse to
  run** on a non-bypassing connection, rather than reporting green over zero visible rows.

To develop against the enforcing shape locally, put both in your `.env`:

```bash
DATABASE_URL=postgres://stopgap_app:stopgap_app@localhost:5433/stopgap
DATABASE_URL_MAINTENANCE=postgres://stopgap:stopgap@localhost:5433/stopgap
```

### Provisioning the role by hand

If you are not using the compose stacks, `deploy/postgres/app-role.sql` is the reference. The three
lines people leave out are the three that matter:

```sql
CREATE ROLE stopgap_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '…';

-- Without USAGE the role cannot NAME anything in the schema: every query fails with
-- "permission denied for schema public" no matter what table grants it holds.
GRANT USAGE ON SCHEMA public TO stopgap_app;

-- The four DML verbs, never `ALL`. `ALL` includes TRUNCATE, and ROW-LEVEL SECURITY DOES NOT APPLY
-- TO TRUNCATE: a role holding it can empty every tenant's cases, protocols and audit chain in one
-- statement with every policy enforcing perfectly. On sequences, `UPDATE` is `setval` — the ability
-- to rewind `audit_log.id` — so only USAGE (nextval) and SELECT are granted.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO stopgap_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO stopgap_app;

-- Grants are per-object and are NOT inherited by tables created later, so without these two the
-- next migration ships a table the application cannot read — a failure that appears one deploy
-- after the change that caused it. `FOR ROLE stopgap` because MIGRATIONS RUN AS THE OWNER, never as
-- `stopgap_app`, which holds no CREATE right on the schema. The verb list MIRRORS the direct grants
-- above: `ALL` here would hand TRUNCATE back on every table a future migration creates.
ALTER DEFAULT PRIVILEGES FOR ROLE stopgap IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stopgap_app;
ALTER DEFAULT PRIVILEGES FOR ROLE stopgap IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO stopgap_app;
```

### The authentication bootstrap

Two lookups are cross-tenant *by nature*, because the org is what they return:

- `getUserByOidc(sub)` — the OIDC callback carries a subject and nothing else.
- `findActiveApiKeyByPlaintext(secret)` — an inbound HTTP request presents a secret and nothing
  else.

Both run before any org is known, so both must run on the BYPASSRLS connection. This is also why
`users_oidc_subject_uq` and `api_keys_key_hash_uq` stay **deployment-wide** rather than becoming
per-org composites: one IdP subject must resolve to exactly one user, and one secret must
authenticate as exactly one tenant.

Both now go through `withBypassDb` explicitly, so `grep -rn "withBypassDb" packages apps` lists
every cross-tenant read in the codebase. **"Unscoped" is not "may read everything"**, and the
distinction is what makes these two safe: each lookup's blast radius is bounded by its QUERY, not by
trust. The predicate is an exact match on a deployment-unique value (an IdP subject; the SHA-256 of
a 256-bit secret), the read is `LIMIT 1`, and the key lookup additionally filters
`revoked_at IS NULL` inside the SQL. The most either can return is the single row belonging to the
credential the caller already presented. `packages/db/src/bypass.test.ts` asserts exactly that.

Outside those two, the only `withBypassDb` callers are the deployment-wide integrity/ops jobs:
audit anchoring, `pnpm verify-audit`, the Prometheus scrape, and the feed poll's org enumeration
plus its write to the global `feed_records`.

`withBypassDb` runs on the **maintenance pool** (`getMaintenanceDb()`), for the reason spelled out
above: not setting `app.current_org` is fail-closed, not a bypass. Both halves are needed — no org
scope *and* a role the policies do not apply to.

## The workflows

**Workflow ids are org-qualified.** `workflowIdForKey(orgId, key)` returns
`org-<orgId>-case-<key>`. Temporal ids are unique per NAMESPACE, not per tenant, so before this the
second hospital short on heparin computed the same `case-heparin` as the first, and its detection
would have been swallowed as "already open" — one org's clinical case suppressing another's.

**Existing rows keep their old ids, and this is load-bearing.** A workflow started as `case-heparin`
still answers only to that id; Temporal has no rename. So `cases.workflow_id` is the authority and
nothing recomputes an id in order to FIND something:

- lookups by key go through `getCaseByKey(db, orgId, key)`, which reads the `(org_id, key)` index
  and is therefore format-independent;
- anything that then needs to reach Temporal — a review signal, an exception resolution, an ack, a
  resolution from the poll, the console's live-state query — uses the `workflowId` on the ROW;
- `upsertCaseForRecord` checks `(org_id, key)` BEFORE inserting, so a recurrence of a pre-migration
  case returns the existing row instead of opening a duplicate one under a new id.

`workflowIdForKey` is now only used to MINT the id of a case that does not exist yet.
`packages/db/src/cases.test.ts` pins all of this, including that a legacy row is still found.

## The feed poll

`pollAndOpenCases` has no session and no case, so it enumerates. One openFDA/ASHP fetch happens for
the whole deployment — a shortage snapshot is a single physical fact about the drug supply,
identical for every hospital, which is exactly why `feed_records` is global — and then the poll
opens or updates a case **per organization** inside that org's own `withOrgDb` scope.

Fetch once, act N times. The alternative readings are both wrong: fetching per tenant multiplies
load on an external API for byte-identical answers, and acting once would mean one hospital's case
represents another hospital's clinical work.

## The audit chain is per-org

Each organization has its own hash chain. `appendAudit` reads the previous hash *within that org*,
the advisory lock is keyed per org (so two hospitals' appends do not serialize against each
other), and a new org's first entry chains to `GENESIS_HASH`.

Scheme **`v4`** = the `v3` field set **plus `org_id`**, so a keyed row cannot be moved between
tenants without breaking its hash. `v1`–`v3` byte layouts are frozen and unchanged — which is
exactly what lets migration 0013 backfill every historical row into the seed org without
invalidating a single hash. With `AUDIT_HMAC_KEY` set, new rows are `v4`; without it, `v1`, as
before. See `docs/audit-integrity.md`.

`verifyAuditChain(db, orgId)` verifies one org. The console's integrity page verifies the signed-in
user's org. `pnpm verify-audit` loops over every org through `withBypassDb`, and it **cannot** pass
vacuously: `assertMaintenanceRoleBypassesRls` runs first and **aborts before any verification
happens** if the connection is not a BYPASSRLS (or superuser) role. Run it as
`stopgap_maintenance`; run it as anything else and you get a refusal naming the problem, never a
green result computed over zero visible rows.

## Anchoring is per-org

Pass 1 made the chain per-tenant but left `audit_anchors` global, which quietly made every anchor
ambiguous: with N chains there is no longer "the head hash", so an anchor pinning `max(audit_log.id)`
pinned whichever tenant happened to append last, and `verifyAnchors` could compare it against a
chain it did not belong to — reporting a mismatch that is not tampering, or a match that proves
nothing about the org whose history was actually rewritten.

Migration **0014** fixes it: `audit_anchors.org_id` (nullable → backfilled to the seed org → NOT
NULL), one anchor row per org per run, and `verifyAnchors` matching on `(org_id, max_audit_id)`
rather than on the id alone — so an anchor relabelled into another tenant is a mismatch instead of a
green result.

The table's policy is **asymmetric**, and that asymmetry is the design: `ENABLE` + `FORCE`, one
`USING` policy for **SELECT** keyed to `app.current_org`, and **no policy at all for INSERT, UPDATE
or DELETE**. With RLS enabled and no permissive policy for a command, that command matches nothing
and is refused.

- A tenant can read the anchors pinning **its own** chain — that metadata is its information.
- A tenant **cannot** write, rewrite or delete any anchor, including its own, so it cannot opt out
  of being anchored. Anchoring runs on the maintenance (BYPASSRLS) connection, to which no policy
  applies.

0013 originally left the table with no policy whatsoever, justified as "a tenant must not be able to
stop its own history being anchored". That justification only covers the write side; the absence of
a policy is not write-only, and it meant any org-scoped connection could read, rewrite or delete
**every other tenant's** anchor rows, with `verifyAnchors`'s application-level `org_id` filter as
the only thing in the way. 0014 keeps the original property and closes that hole.

**Old anchor-file lines are handled explicitly.** Lines appended before this change carry no
`orgId`. `readAnchorFile` attributes them to `SEED_ORG_ID` — not a guess: at the time they were
written the deployment had exactly one tenant, the one migration 0013 backfilled everything into.
Skipping them would discard the strongest tamper evidence the deployment has (the external record
predates the change); throwing would crash the verification path on a file that is doing its job.

## The console's org picker

§6.5 asks for an "org picker for multi-org admins". One IdP subject is one `users` row is one org,
so ordinary users are single-org **by construction** and have nothing to pick between. The picker is
therefore implemented as an **admin-only active-org switch** (`/admin/organizations`):

- selecting an org stores its id in an `httpOnly`, `sameSite=lax` cookie **with a one-hour
  `maxAge`**, so the elevated state expires on its own. That lifetime is the point: nothing else in
  the system ends the switch. Without it the cookie is a session cookie that survives every
  navigation and, in a browser that restores tabs, days of them — an admin who switched on Tuesday
  would still be acting inside the other hospital on Thursday, with every clinical action taken
  since landing in that tenant's data and audit chain, each one individually successful and
  correctly recorded, in the wrong facility. An hour is long enough for a real cross-tenant task and
  short enough that it cannot outlive the reason for it; re-switching is one click;
- while an admin is acting outside their own org, the console header shows a prominent **"Acting in
  &lt;hospital&gt;"** badge (`app/active-org-badge.tsx`) linking back to the switcher. It renders
  only in the elevated state, because a badge that is always there is a badge nobody reads;
- `resolvePrincipal` consults that cookie **only** when the caller holds the `admin` role AND the
  value names a real organization; otherwise the user's own `users.org_id` wins. Both checks are
  server-side, because a cookie is client-controlled state — honouring it unconditionally would hand
  tenant selection to anyone who can set a header;
- `setActiveOrgAction` re-checks `requireRole`, verifies the org exists, and **appends the audit
  entry before setting the cookie**, in the org being ENTERED, so that tenant's own audit export
  contains "an admin from outside acted here";
- every subsequent audit entry records the org actually acted in.

**State the security property plainly: this lets a deployment admin read and write inside any
tenant.** That is a real privilege, which is why it is admin-gated, existence-checked and audited,
and why the page says so rather than presenting the switch as a view filter.

**It is not multi-org membership.** A genuine multi-org *pharmacist* — one clinician who legitimately
works at two facilities — needs a `user_organizations` join table with per-org role grants and a
picker limited to the orgs they belong to. This PR does not build that, and the deferral is recorded
as an open question under §6.5 in `PHASE6-PLAN.md`.

## Ops metrics are deployment-wide, and carry NO org label

A Prometheus scrape has no session, no request and no key, so there is nothing to derive an org
from. The obvious answer — emit each case-derived gauge once per organization, labelled with the
tenant's slug — was built and then removed, because of **where these gauges are served from**.

`/api/metrics` is exempted from the auth middleware so Prometheus can scrape it, which means it is
readable by anyone who can reach the console, including any single tenant's users. Per-org series
would publish, to that audience, the list of every hospital on the deployment plus each one's case
volume, exception-queue depth and oldest unacknowledged critical case. That is tenant enumeration
dressed as observability, and §6.5 never asked for it.

So the gauges are aggregates over the whole deployment — computed as ONE query
(`getOpsMetrics(undefined, db)` on the maintenance connection), not by summing per-org results, because
an average of per-tenant average ack latencies is not the deployment's average ack latency.

**The cost, stated:** `stopgap_critical_case_unacked_seconds > 3600` names the deployment, not the
facility, so an operator still opens the console to find which hospital is behind. Per-org series
need an **authenticated scrape**; that is recorded as an open question under §6.5 in
`PHASE6-PLAN.md` rather than solved by inventing a token scheme.

## The seed organization

Migration 0013 inserts one organization with a **fixed** id, and backfills every pre-existing row
into it:

```text
id   00000000-0000-0000-0000-0000000000a1   (SEED_ORG_ID in packages/db/src/orgs.ts)
slug stopgap
name Stopgap (seed organization)
```

Fixed rather than generated so the migration's backfill and the application agree without a lookup,
and so the same id means the same tenant in every deployment — a dump from one machine stays
readable on another. The public demo maps to this org, and `resolvePrincipal` says so for the
anonymous viewer: the demo IS the seed tenant, read-only through the existing demo gates.

## The second organization

§6.5's acceptance is "two seeded orgs run side by side; cases, protocols, shadow, audit fully
disjoint". One tenant demonstrates nothing — every query returns the same rows whether or not the
policies work — so migration **0014** creates a second:

```text
id   00000000-0000-0000-0000-0000000000a2   (SECOND_ORG_ID in packages/db/src/orgs.ts)
slug riverside
name Riverside General (second seeded organization)
```

The ROW is created by the migration rather than only by the demo seeder, because that seeder refuses
to run unless `STOPGAP_DEMO_MODE=on` (its cases are fiction and must never sit beside real
shortages). An empty organization is not fiction — it is an isolation boundary with nothing in it —
so a plain `pnpm db:migrate` already yields two tenants, and `pnpm --filter @stopgap/demo seed` then
fills both with content.

### Filling both orgs, including shadow

§6.5's acceptance is "cases, protocols, shadow, audit fully disjoint", and the **shadow** part needs
one extra step that is easy to miss. `pnpm --filter @stopgap/demo seed` fills both orgs' cases,
protocols and audit, but shadow runs come from the replay script, which writes into **one** org per
invocation — `STOPGAP_ORG_ID`, defaulting to the seed org. Run it once per tenant, or org B's shadow
dashboard is empty and the acceptance cannot be observed:

```bash
pnpm infra:up && pnpm db:migrate
STOPGAP_DEMO_MODE=on pnpm --filter @stopgap/demo seed

# Shadow, once per organization — the default writes only into the seed org.
STOPGAP_ORG_ID=00000000-0000-0000-0000-0000000000a1 pnpm --filter @stopgap/shadow replay
STOPGAP_ORG_ID=00000000-0000-0000-0000-0000000000a2 pnpm --filter @stopgap/shadow replay
```

Then sign in as an admin, switch the active org at `/admin/organizations`, and every surface —
cases, protocols, `/shadow`, `/audit` — changes completely. That change is the acceptance.

The demo content is deliberately **overlapping but not identical**: both orgs get a
`demo-seed-heparin` case (proving two tenants can hold a case for the same drug without colliding —
the `(org_id, key)` and `(org_id, workflow_id)` indexes, and the org-qualified Temporal id), while
the seed org additionally gets cefazolin and IVIG. Switching the active org therefore visibly
changes the whole console, which is what an isolation demo has to show.

## Testing isolation

The cross-tenant tests need a live database and are **not** part of `pnpm gate`:

```bash
pnpm infra:up && pnpm db:migrate     # `up` also creates stopgap_app (app-role-init)
DATABASE_URL=postgres://stopgap_app:stopgap_app@localhost:5433/stopgap \
DATABASE_URL_MAINTENANCE=postgres://stopgap:stopgap@localhost:5433/stopgap \
  pnpm test:rls
```

Both urls are required, and they exercise different halves of the design — see the header of
`rls.e2e.test.ts`.

`packages/db/src/tenant-keys.e2e.test.ts` asserts the other half of the model: one probe per
composite key, each writing a row whose `org_id` is the caller's own and whose parent belongs to
another tenant, and each expected to be refused by the DATABASE with `23503` naming that specific
constraint. Under the plain keys these replaced, every one of those writes succeeded.

`packages/db/src/rls.e2e.test.ts` asserts, once per tenant table, that org A sees zero of org B's
rows, that a cross-tenant **UPDATE and DELETE affect zero rows** (with org B's row still intact
afterwards — a read policy is not a write guarantee), that an INSERT with a foreign `org_id` is
refused, and that an unscoped session sees nothing. It also covers the per-org audit chain (each
org's rows are disjoint, a new org's first entry chains to genesis rather than to another tenant's
head, org A cannot append into org B's chain) and `audit_anchors`' asymmetric policy (a tenant reads
only its own anchors and cannot write any). Its `beforeAll` **refuses to run** if the connected role
is a superuser or holds `BYPASSRLS` — a suite that reports isolation working when it is not is worse
than no suite.

`packages/db/src/migrations.e2e.test.ts` runs in the same suite and covers the other thing this repo
cannot check offline: it creates a throwaway database, applies migrations `0000`–`0012`, seeds rows
through that pre-multi-tenancy schema (including a real `v1` audit chain), then applies `0013`/`0014`
and asserts that every row survived, that all of them landed in the seed org, and that
**`verifyAuditChain(seedOrg)` is still green across the boundary**. That last assertion is the one
that matters: `v1` hashes a frozen payload with no `org_id`, which is the only reason the backfill
cannot invalidate a historical entry — if it ever goes red, every deployment's history has become
permanently unverifiable and the chain is reporting tampering that never happened.

A further live suite, `packages/db/src/public-lists.e2e.test.ts` (ticket 19), covers the public API's
read queries: two tenants holding deliberately similar signals, snapshots and items, so a missing
`org_id` predicate surfaces as another hospital's row rather than as an empty result that reads like
a pass. It needs the same application role as `rls.e2e.test.ts` and refuses to run under the owner.

**`pnpm gate` still runs offline and still proves none of this.** Nothing in it can show that
Postgres refuses a cross-tenant row or that `0013`/`0014` apply cleanly; the SQL was hand-verified
and the live suites in `vitest.rls.config.ts` are how you check it, against a live server, yourself.

What the zero-config gate DOES prove is the layer above the database — that the application never
ASKS for a cross-tenant row. With `withOrgDb` stubbed to record the org it was opened for:

- `apps/console/app/lib/actions.test.ts` — a console action scopes its DB work and its audit append
  to the session's org;
- `apps/console/app/api/v1/cases/route.test.ts`, `apps/console/app/api/v1/signals/route.test.ts` and
  `apps/console/app/lib/api-auth.test.ts` — a REST route scopes to the KEY's org and ignores every
  org-shaped query parameter and header;
- `packages/workflows/src/activities.tenancy.test.ts` — a workflow activity scopes to
  `CaseInput.orgId`, and the feed poll fetches once and opens one case per organization;
- `apps/console/app/lib/principal.test.ts` — the four tenant-resolution outcomes (own org, cookie
  ignored for a non-admin, honoured for an admin with a valid org, seed org for the demo viewer);
- `packages/db/src/cases.test.ts` — a case written before workflow ids became org-qualified is still
  found, and is not duplicated;
- `packages/db/src/anchors.test.ts` — per-org anchoring, and an old anchor-file line with no org.

## Demo: prove it in psql

> **Connect as `stopgap_app`, not as `stopgap`.** This is the first thing to get right, not a
> footnote: `stopgap` is a superuser, a superuser bypasses every policy unconditionally, and every
> command below will return every tenant's rows and prove the exact opposite of what it claims.
>
> ```bash
> psql postgres://stopgap_app:stopgap_app@localhost:5433/stopgap
> ```
>
> Confirm before you start — both columns must be `f`:
>
> ```sql
> SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
> ```

```sql
SELECT set_config('app.current_org', '00000000-0000-0000-0000-0000000000a1', false);
SELECT count(*) FROM cases;                       -- the seed org's cases

SELECT set_config('app.current_org', '<other-org-uuid>', false);
SELECT count(*) FROM cases;                       -- 0

RESET app.current_org;
SELECT count(*) FROM cases;                       -- 0, not "all of them"

-- And the write side:
INSERT INTO cases (org_id, workflow_id, key, generic_name, source, source_id)
VALUES ('00000000-0000-0000-0000-0000000000a1', 'case-x', 'x', 'X', 'openfda', 's');
-- ERROR:  new row violates row-level security policy for table "cases"
```
