import { sql } from "drizzle-orm";
import { getDb, getMaintenanceDb, type Db } from "./client.js";

/**
 * Per-request tenant scoping (PHASE6 §6.5) — the bridge between "this session belongs to org X"
 * and the Postgres row-level security policies that enforce it.
 *
 * Every RLS policy written by migration 0013 has the same shape:
 *
 *   USING (org_id = current_setting('app.current_org', true)::uuid)
 *
 * so the ONLY thing that makes a tenant's rows visible is that setting. This module is the one
 * sanctioned way to set it, and the one sanctioned way to opt out of it.
 */

/**
 * A uuid, in the exact textual form Postgres will cast. Validated before the value reaches the
 * database because `set_config` takes TEXT: an invalid uuid would not fail at the call, it would
 * fail later at the `::uuid` cast inside a policy, mid-statement, with an error that names the
 * policy rather than the caller who passed the bad org.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` with every query inside it scoped to one tenant.
 *
 * THE SINGLE MOST IMPORTANT DETAIL IN THIS FILE is the third argument to `set_config`: `true`
 * means LOCAL — the setting is scoped to the surrounding TRANSACTION and is reverted on commit
 * or rollback. The app talks to Postgres through a `postgres.js` pool (`max: 10` in `client.ts`),
 * so a connection is handed straight to the next request when this one finishes. A session-level
 * `set` (or `set_config(..., false)`) would survive that handoff: the next request to check out
 * that connection would inherit the PREVIOUS request's org and, if it forgot to set its own,
 * would read another hospital's cases with the policies reporting everything as working. That is
 * a cross-tenant leak produced by connection reuse alone, with no application bug to find. The
 * transaction-scoped form makes the leak structurally impossible — the setting cannot outlive the
 * transaction that established it.
 *
 * The value is passed as a BIND PARAMETER, not interpolated. `SET LOCAL app.current_org = ...`
 * is the more familiar spelling but it is parsed as a utility statement and cannot take a
 * placeholder, which would force string concatenation into SQL on the one code path whose whole
 * job is deciding which tenant's data you may see. `set_config(name, value, is_local)` is the
 * function form of the same thing and DOES take parameters, so the org id crosses the wire as
 * data. The uuid check above is belt to that braces: it rejects a malformed org at the boundary
 * rather than letting it become a cast error deep inside a policy evaluation.
 *
 * `fn` receives the transaction handle. Queries issued on it inherit the setting; queries issued
 * on a DIFFERENT handle (a stray `getDb()` call inside the callback) run on a DIFFERENT pooled
 * connection where `app.current_org` is unset — and, per the fail-closed note below, will see
 * nothing rather than everything. Pass the handle down.
 */
export async function withOrgDb<T>(orgId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(orgId)) {
    throw new Error(`withOrgDb: orgId must be a uuid, got ${JSON.stringify(orgId)}`);
  }
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_org', ${orgId}, true)`);
    return fn(tx as unknown as Db);
  });
}

/**
 * Run `fn` with NO tenant scope — the explicit, named, auditable escape hatch for the handful of
 * jobs that are genuinely deployment-wide: audit anchoring (which pins `max(audit_log.id)`, a
 * sequence shared by every org), cross-org chain verification, and migrations.
 *
 * This is the ONLY sanctioned way to read across tenants. It exists as a function with a
 * conspicuous name rather than as "just call `getDb()`" so that cross-tenant access is a thing a
 * reviewer can grep for and a thing a diff makes obvious, instead of being the accidental default
 * that any forgotten `withOrgDb` silently produces.
 *
 * TWO THINGS ARE REQUIRED to actually read across tenants, and only one of them is the absence of
 * a scope. `app.current_org` is never set here, so `current_setting('app.current_org', true)`
 * returns NULL, every policy predicate evaluates to NULL, and NULL is not TRUE — on an ordinary
 * role the rows are INVISIBLE, not universally visible. That is the correct fail-closed direction
 * (a forgotten scope shows an empty page, not another hospital's patients), but it also means an
 * unscoped connection alone cannot do this function's job. The other half is the CONNECTION: RLS
 * applies to a role, not to a statement, so the query has to arrive on a connection whose role
 * holds `BYPASSRLS` (or is a superuser). That connection is `getMaintenanceDb()`, configured by
 * `DATABASE_URL_MAINTENANCE`.
 *
 * When that variable is unset the maintenance pool IS the ordinary pool — the single-role
 * development configuration, documented as such in `packages/core/src/env.ts` and
 * `docs/multi-tenancy.md`. It is correct only where the app role already bypasses RLS (the compose
 * superuser). Where it does not, this function does not pretend the bypass happened: the reads
 * return nothing, `client.ts` logs a loud warning at pool creation, `/api/readyz` reports it as a
 * named check, and the two jobs whose failure would otherwise be a vacuous green
 * (`anchorAuditChain`, `pnpm verify-audit`) call `assertMaintenanceRoleBypassesRls` and refuse.
 */
export async function withBypassDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return fn(getMaintenanceDb());
}
