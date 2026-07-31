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
  const [row] = await db.insert(shadowRuns).values(run).returning();
  return row!;
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
