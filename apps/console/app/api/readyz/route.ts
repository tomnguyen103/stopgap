import { authConfigured, getEnv } from "@stopgap/core";
import { checkAppRoleRls, checkMaintenanceConnection, pingDb } from "@stopgap/db";
import { checkTemporal } from "@stopgap/workflows";
import { NextResponse } from "next/server";

/**
 * Readiness (PHASE6 §6.4): can the console actually do its job? It reaches Postgres (`select 1`)
 * and Temporal (cluster info) and returns 200 ONLY if both answer; otherwise 503 naming the
 * dependency that is down. This is the honest-signal stance applied to health: "up but can't serve"
 * is a distinct state a plain liveness check hides, and a faked 200 here would route traffic to a
 * console that cannot read a case. Explicit demo mode is ready without auth; every other process
 * is ready only when both auth secrets are configured. Unauthenticated (exempted in middleware)
 * so probes can reach it.
 *
 * `rlsEnforced` is a REPORTED condition, not a gate (PHASE6 §6.5). It says whether the tenant
 * isolation policies actually apply to the connected application role. When it is false the
 * policies are installed and enforcing nothing — a state that is otherwise completely silent, since
 * every query still succeeds and every page still renders. It deliberately does NOT fail readiness:
 * single-role local development legitimately connects as the compose superuser, and 503-ing the dev
 * stack to make a point would only teach operators to ignore the check. `null` means the probe
 * could not reach the database — unknown, reported as unknown rather than as fine.
 *
 * `maintenanceConnection` is a SEPARATE named check and, unlike `rlsEnforced`, it DOES fail
 * readiness — but only in production (PHASE6 §6.5). The two conditions are independent, which is
 * why neither is folded into the other: a production deployment that omits
 * `DATABASE_URL_MAINTENANCE` reports `rlsEnforced: true` (the policies really are applying) while
 * every cross-tenant read returns zero rows. OIDC sign-in cannot resolve a subject to an
 * organization, REST key authentication cannot resolve a key hash, anchoring and verification
 * refuse to run — and the console comes up, serves the anonymous demo viewer, and passes every
 * other probe. Nobody can log in and nothing says why. In development the check reports its state
 * and does not gate, because the single-role local stack legitimately has no second connection.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const env = getEnv();
  const demoMode = env.STOPGAP_DEMO_MODE === "on";
  const authenticationConfigured = authConfigured(env);
  const authenticationReady = demoMode || authenticationConfigured;
  const [database, temporal, rls, maintenance] = await Promise.all([
    pingDb(),
    checkTemporal(),
    checkAppRoleRls(),
    checkMaintenanceConnection(),
  ]);
  const ready = database && temporal && maintenance.ok && authenticationReady;
  return NextResponse.json(
    {
      ready,
      checks: {
        database,
        temporal,
        authentication: {
          ok: authenticationReady,
          configured: authenticationConfigured,
          required: !demoMode,
          demoMode,
        },
        // true = the policies apply to this connection; false = this role bypasses them; null = unknown.
        rlsEnforced: rls.checked ? !rls.bypassesRls : null,
        // Named only when it is the bad case, so the field's presence is itself the signal.
        ...(rls.checked && rls.bypassesRls ? { rlsBypassRole: rls.role ?? null } : {}),
        // Gates readiness in production only; reported everywhere. `required` says which of those
        // this process is, so a 200 in development is not mistaken for a configured deployment.
        maintenanceConnection: {
          ok: maintenance.ok,
          configured: maintenance.configured,
          required: maintenance.required,
          ...(maintenance.reason ? { reason: maintenance.reason } : {}),
        },
      },
    },
    { status: ready ? 200 : 503 },
  );
}
