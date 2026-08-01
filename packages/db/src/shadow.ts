import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, type Db } from "./client.js";
import { shadowRuns } from "./schema.js";
import type { NewShadowRunRow, ShadowRunRow } from "./schema.js";

/**
 * Persistence for the shadow ledger (PROJECT_PLAN §3A). Scoring lives in `@stopgap/shadow`.
 *
 * Org-scoped per PHASE6 §6.5 (see the ORG SCOPING note in `cases.ts`). `recordShadowRun` needs no
 * new parameter: `orgId` is a NOT NULL column on `shadowRuns`, so it is already part of
 * `NewShadowRunRow` and the type checker refuses a run with no tenant.
 */

export async function recordShadowRun(
  run: NewShadowRunRow,
  db: Db = getDb(),
): Promise<ShadowRunRow> {
  const replayDay = run.replayDay ?? new Date().toISOString().slice(0, 10);
  const [row] = await db
    .insert(shadowRuns)
    .values({ ...run, replayDay })
    // The replay-day index is partial so legacy duplicate rows can retain a NULL day. An
    // unqualified DO NOTHING lets PostgreSQL infer that index without relying on a conflict-target
    // predicate unsupported by this Drizzle version; the generated id has no other conflict path.
    .onConflictDoNothing()
    .returning();
  if (row) return row;

  // A retry of the same UTC replay day is expected to find the already measured sample. The
  // unique index makes the check race-safe; returning the existing row keeps callers idempotent
  // without inflating promotion evidence or throwing a false failure.
  const [existing] = await db
    .select()
    .from(shadowRuns)
    .where(
      and(
        eq(shadowRuns.orgId, run.orgId),
        eq(shadowRuns.corpusId, run.corpusId),
        eq(shadowRuns.replayDay, replayDay),
      ),
    )
    .limit(1);
  if (!existing) throw new Error(`shadow run conflict without existing row for ${run.corpusId}`);
  return existing;
}

/**
 * Whether this corpus item already has a measured sample for the UTC replay day.
 *
 * The replay job checks this before invoking the agents so a retry after one failed corpus item
 * does not spend model work recomputing entries that already committed successfully. The unique
 * index remains the race-safe write boundary in `recordShadowRun`; this is an optimization and a
 * retry guard, not the integrity control.
 */
export async function hasShadowRunForReplay(
  orgId: string,
  corpusId: string,
  replayDay: string,
  db: Db = getDb(),
): Promise<boolean> {
  const [row] = await db
    .select({ id: shadowRuns.id })
    .from(shadowRuns)
    .where(
      and(
        eq(shadowRuns.orgId, orgId),
        eq(shadowRuns.corpusId, corpusId),
        eq(shadowRuns.replayDay, replayDay),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function listShadowRuns(
  orgId: string,
  limit = 100,
  db: Db = getDb(),
): Promise<ShadowRunRow[]> {
  return db
    .select()
    .from(shadowRuns)
    .where(eq(shadowRuns.orgId, orgId))
    .orderBy(desc(shadowRuns.ranAt))
    .limit(limit);
}

export interface ShadowClassStats {
  drugClass: string | null;
  runs: number;
  /** Mean 0-1 agreement across the class. */
  meanAgreement: number;
  /** Share of runs where the severity call matched exactly. */
  severityAgreementRate: number;
  /** Share of runs where the agent called the shortage less severe than the human did. */
  underEscalationRate: number;
  meanLatencyMs: number;
  totalUsdCost: number;
}

/**
 * Per-drug-class aggregates — the input to the promotion gates. Aggregating in SQL rather
 * than in Node keeps the dashboard query O(classes) instead of pulling the whole ledger.
 */
export async function shadowStatsByClass(
  orgId: string,
  db: Db = getDb(),
): Promise<ShadowClassStats[]> {
  const rows = await db
    .select({
      drugClass: shadowRuns.drugClass,
      runs: sql<string>`count(*)`,
      meanAgreement: sql<string>`avg(${shadowRuns.agreement})`,
      severityAgreed: sql<string>`sum(case when ${shadowRuns.severityAgreed} then 1 else 0 end)`,
      underCalled: sql<string>`sum(case when ${shadowRuns.severityUnderCalled} then 1 else 0 end)`,
      meanLatencyMs: sql<string>`avg(${shadowRuns.latencyMs})`,
      totalUsdCost: sql<string>`sum(${shadowRuns.usdCost})`,
    })
    .from(shadowRuns)
    .where(eq(shadowRuns.orgId, orgId))
    .groupBy(shadowRuns.drugClass);

  return rows.map((row) => {
    const runs = Number(row.runs);
    return {
      drugClass: row.drugClass,
      runs,
      meanAgreement: Number(row.meanAgreement ?? 0),
      severityAgreementRate: runs === 0 ? 0 : Number(row.severityAgreed) / runs,
      underEscalationRate: runs === 0 ? 0 : Number(row.underCalled) / runs,
      meanLatencyMs: Number(row.meanLatencyMs ?? 0),
      totalUsdCost: Number(row.totalUsdCost ?? 0),
    };
  });
}

/** Runs for one drug class, newest first — the disagreement-triage view. */
export async function listShadowRunsForClass(
  orgId: string,
  drugClass: string,
  limit = 100,
  db: Db = getDb(),
): Promise<ShadowRunRow[]> {
  return db
    .select()
    .from(shadowRuns)
    .where(and(eq(shadowRuns.orgId, orgId), eq(shadowRuns.drugClass, drugClass)))
    .orderBy(desc(shadowRuns.ranAt))
    .limit(limit);
}
