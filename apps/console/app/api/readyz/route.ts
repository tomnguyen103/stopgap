import { checkAppRoleRls, pingDb } from "@stopgap/db";
import { checkTemporal } from "@stopgap/workflows";
import { NextResponse } from "next/server";

/**
 * Readiness (PHASE6 §6.4): can the console actually do its job? It reaches Postgres (`select 1`)
 * and Temporal (cluster info) and returns 200 ONLY if both answer; otherwise 503 naming the
 * dependency that is down. This is the honest-signal stance applied to health: "up but can't serve"
 * is a distinct state a plain liveness check hides, and a faked 200 here would route traffic to a
 * console that cannot read a case. Unauthenticated (exempted in middleware) so probes can reach it.
 *
 * `rlsEnforced` is a REPORTED condition, not a gate (PHASE6 §6.5). It says whether the tenant
 * isolation policies actually apply to the connected application role. When it is false the
 * policies are installed and enforcing nothing — a state that is otherwise completely silent, since
 * every query still succeeds and every page still renders. It deliberately does NOT fail readiness:
 * single-role local development legitimately connects as the compose superuser, and 503-ing the dev
 * stack to make a point would only teach operators to ignore the check. `null` means the probe
 * could not reach the database — unknown, reported as unknown rather than as fine.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const [database, temporal, rls] = await Promise.all([pingDb(), checkTemporal(), checkAppRoleRls()]);
  const ready = database && temporal;
  return NextResponse.json(
    {
      ready,
      checks: {
        database,
        temporal,
        // true = the policies apply to this connection; false = this role bypasses them; null = unknown.
        rlsEnforced: rls.checked ? !rls.bypassesRls : null,
        // Named only when it is the bad case, so the field's presence is itself the signal.
        ...(rls.checked && rls.bypassesRls ? { rlsBypassRole: rls.role ?? null } : {}),
      },
    },
    { status: ready ? 200 : 503 },
  );
}
