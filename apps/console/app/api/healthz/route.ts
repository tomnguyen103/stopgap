import { NextResponse } from "next/server";

/**
 * Liveness (PHASE6 §6.4): is the process up and serving? Always 200 — it says nothing about
 * dependencies (that is `/readyz`'s job). A liveness probe that also checked Postgres would
 * restart a healthy console every time the database blipped, which is the opposite of what a
 * liveness probe is for. Unauthenticated (exempted in middleware) so an orchestrator can reach it.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json({ status: "ok" });
}
