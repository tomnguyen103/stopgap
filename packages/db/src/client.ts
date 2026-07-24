import { getEnv } from "@stopgap/core/env";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

/**
 * Lazily-constructed singleton DB client. Kept lazy so packages can import query helpers
 * without opening a connection at module load (matters for tests and the console).
 */
let sqlClient: ReturnType<typeof postgres> | undefined;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getDb() {
  if (!dbInstance) {
    sqlClient = postgres(getEnv().DATABASE_URL, { max: 10 });
    dbInstance = drizzle(sqlClient, { schema });
    // Fire-and-forget: the probe below is the ONLY thing in the process that notices the
    // application is connected as a role the RLS policies do not apply to. Not awaited, because
    // `getDb()` is synchronous and every caller would otherwise pay a round trip; the promise is
    // memoised, so `/api/readyz` awaiting it later gets the same answer rather than a second probe.
    void checkAppRoleRls();
  }
  return dbInstance;
}

/**
 * The MAINTENANCE pool (PHASE6 §6.5) — a second, separately-configured connection for the jobs
 * that are genuinely deployment-wide: the authentication bootstrap (an OIDC subject or an API-key
 * secret resolves to an org, so the org cannot be known yet), audit anchoring, `pnpm verify-audit`,
 * and the Prometheus scrape.
 *
 * WHY IT EXISTS AT ALL. Row-level security applies to a ROLE, not to a statement: there is no
 * "ignore the policies for this query". `withBypassDb` running on the SAME pool as everything else
 * therefore bypasses nothing, and the deployment is forced to choose between two broken states —
 * connect as a superuser and the policies are decoration, or connect as a plain application role
 * and sign-in, REST authentication and anchoring stop working. A second pool, connected as a role
 * that holds BYPASSRLS, is the only way both properties hold at once.
 *
 * WHEN `DATABASE_URL_MAINTENANCE` IS UNSET this returns the ORDINARY pool. That is the single-role
 * DEVELOPMENT configuration and it is stated as such rather than dressed up: it is correct only
 * because the zero-config compose stack's `DATABASE_URL` names a superuser, which bypasses every
 * policy anyway. In a deployment where the app role is (correctly) not a superuser, the fallback
 * does NOT quietly succeed — the bypass reads return zero rows, `assertMaintenanceRoleBypassesRls`
 * refuses to let anchoring and verification report vacuous success, and the pool logs the warning
 * below. Nothing here pretends the bypass happened.
 */
let maintenanceSqlClient: ReturnType<typeof postgres> | undefined;
let maintenanceDbInstance: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getMaintenanceDb() {
  const url = getEnv().DATABASE_URL_MAINTENANCE;
  if (!url) return getDb();
  if (!maintenanceDbInstance) {
    // A SMALLER pool than the application's on purpose. The maintenance connection serves
    // low-frequency jobs (a sign-in, an hourly anchor, a scrape); sizing it like the request pool
    // would double this process's connection footprint against the server's `max_connections` for
    // capacity nothing uses.
    maintenanceSqlClient = postgres(url, { max: 4 });
    maintenanceDbInstance = drizzle(maintenanceSqlClient, { schema });
  }
  return maintenanceDbInstance;
}

/**
 * What row-level security means for a given connection: does the connected role IGNORE the
 * policies? A superuser does unconditionally (`FORCE ROW LEVEL SECURITY` does not apply to it),
 * and so does any role holding `BYPASSRLS`.
 *
 * `checked: false` is a distinct, honest state — the probe could not reach the database, so the
 * answer is unknown rather than "fine". Callers that need the guarantee (anchoring, verification)
 * treat unknown as a failure; the readiness endpoint reports it as unknown.
 */
export interface RoleRlsStatus {
  /** Did the probe actually get an answer from Postgres? */
  checked: boolean;
  /** `current_user`, when known. */
  role?: string;
  superuser?: boolean;
  bypassrls?: boolean;
  /** True when this connection is exempt from every policy (superuser OR BYPASSRLS). */
  bypassesRls: boolean;
  /** Why the probe could not answer, when `checked` is false. */
  reason?: string;
}

async function probeRoleRls(db: ReturnType<typeof getDb>): Promise<RoleRlsStatus> {
  try {
    const rows = await db.execute<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      sql`select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    const row = rows[0];
    if (!row) {
      // `pg_roles` is readable by every role, so an empty result means the connection is not what
      // it claims (a proxy rewriting `current_user`, say). Unknown, not fine.
      return { checked: false, bypassesRls: false, reason: "current_user not found in pg_roles" };
    }
    return {
      checked: true,
      role: row.rolname,
      superuser: row.rolsuper,
      bypassrls: row.rolbypassrls,
      bypassesRls: row.rolsuper || row.rolbypassrls,
    };
  } catch (err) {
    return { checked: false, bypassesRls: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

let appRoleRls: Promise<RoleRlsStatus> | undefined;

/**
 * Is the APPLICATION connection exempt from the RLS policies (PHASE6 §6.5)? Probed once per
 * process, on first pool use, and memoised — the answer cannot change without a reconnect.
 *
 * The loud warning is the whole point. Nothing else in the system notices this condition: every
 * query still succeeds, every test still passes, the console still works, and the isolation the
 * deployment believes it has simply is not there. That failure is silent by construction, which is
 * why it is stated at startup instead of left to be discovered by an auditor.
 *
 * It is NOT a hard failure. Local development legitimately runs single-role against the compose
 * superuser, and refusing to boot would make the zero-config stack unusable to make a point. The
 * condition is surfaced (here, and as a named check on `/api/readyz`) rather than enforced.
 */
export function checkAppRoleRls(): Promise<RoleRlsStatus> {
  appRoleRls ??= probeRoleRls(getDb()).then((status) => {
    if (status.bypassesRls) {
      console.warn(
        `[db] ROW-LEVEL SECURITY IS NOT BEING ENFORCED. The application is connected as ` +
          `"${status.role ?? "?"}", which is ${status.superuser ? "a SUPERUSER" : "BYPASSRLS"}. ` +
          "Every tenant-isolation policy installed by migration 0013 is skipped for this " +
          "connection, so a query that loses its org filter returns other organizations' rows. " +
          "This is tolerable ONLY for single-role local development. For a deployment, point " +
          "DATABASE_URL at a plain application role (neither SUPERUSER nor BYPASSRLS) and " +
          "DATABASE_URL_MAINTENANCE at the bypassing role — see docs/multi-tenancy.md.",
      );
    } else if (!status.checked) {
      console.warn(`[db] could not determine whether RLS applies to this connection: ${status.reason ?? "unknown"}`);
    }
    return status;
  });
  return appRoleRls;
}

let maintenanceRoleRls: Promise<RoleRlsStatus> | undefined;

/** Same probe, against the MAINTENANCE connection (which may be the same pool when unconfigured). */
export function checkMaintenanceRoleRls(): Promise<RoleRlsStatus> {
  maintenanceRoleRls ??= probeRoleRls(getMaintenanceDb());
  return maintenanceRoleRls;
}

/**
 * Refuse to continue unless the maintenance connection genuinely bypasses RLS.
 *
 * THE FAILURE THIS PREVENTS IS VACUOUS SUCCESS. Audit anchoring and `pnpm verify-audit` are
 * cross-tenant reads. On a connection the policies DO apply to, every per-org query returns zero
 * rows — so anchoring silently anchors nothing and verification cheerfully reports "chains OK" over
 * an empty result set. Both would be reporting the strongest integrity guarantee the system offers
 * while checking nothing at all, which is worse than not running them. Mirrors the `beforeAll`
 * guard in `packages/db/src/rls.e2e.test.ts`, for the same reason.
 *
 * `context` names the caller so the error says which job refused to run.
 */
export async function assertMaintenanceRoleBypassesRls(context: string): Promise<void> {
  const status = await checkMaintenanceRoleRls();
  if (!status.checked) {
    throw new Error(
      `${context}: could not determine whether the maintenance connection bypasses row-level ` +
        `security (${status.reason ?? "unknown"}). Refusing to run rather than report a result ` +
        "that may have been computed over zero visible rows.",
    );
  }
  if (!status.bypassesRls) {
    throw new Error(
      `${context}: connected as "${status.role ?? "?"}", which holds neither SUPERUSER nor ` +
        "BYPASSRLS. This is a cross-tenant job, so on this connection every per-organization query " +
        "returns zero rows and the job would report success having done nothing. Set " +
        "DATABASE_URL_MAINTENANCE to a role holding BYPASSRLS (see docs/multi-tenancy.md).",
    );
  }
}

/**
 * Is the database reachable (PHASE6 §6.4 readiness)? Runs `select 1` and returns a boolean rather
 * than throwing, so `/readyz` can report the database as down without 500-ing — honest "not ready".
 */
export async function pingDb(): Promise<boolean> {
  try {
    await getDb().execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

/** Close both pools (tests, graceful shutdown). */
export async function closeDb(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
    sqlClient = undefined;
    dbInstance = undefined;
  }
  if (maintenanceSqlClient) {
    await maintenanceSqlClient.end({ timeout: 5 });
    maintenanceSqlClient = undefined;
    maintenanceDbInstance = undefined;
  }
  // The probes describe a CONNECTION, so they die with it: a reconnect under a different
  // DATABASE_URL must be re-probed rather than inheriting the previous role's answer.
  appRoleRls = undefined;
  maintenanceRoleRls = undefined;
}

export type Db = ReturnType<typeof getDb>;
