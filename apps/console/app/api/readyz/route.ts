import { pingDb } from "@stopgap/db";
import { checkTemporal } from "@stopgap/workflows";
import { NextResponse } from "next/server";

/**
 * Readiness (PHASE6 §6.4): can the console actually do its job? It reaches Postgres (`select 1`)
 * and Temporal (cluster info) and returns 200 ONLY if both answer; otherwise 503 naming the
 * dependency that is down. This is the honest-signal stance applied to health: "up but can't serve"
 * is a distinct state a plain liveness check hides, and a faked 200 here would route traffic to a
 * console that cannot read a case. Unauthenticated (exempted in middleware) so probes can reach it.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const [database, temporal] = await Promise.all([pingDb(), checkTemporal()]);
  const ready = database && temporal;
  return NextResponse.json({ ready, checks: { database, temporal } }, { status: ready ? 200 : 503 });
}
