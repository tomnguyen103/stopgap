import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "./client.js";
import { shadowRuns } from "./schema.js";
import type { NewShadowRunRow, ShadowRunRow } from "./schema.js";

/** Persistence for the shadow ledger (PROJECT_PLAN §3A). Scoring lives in `@stopgap/shadow`. */

export async function recordShadowRun(run: NewShadowRunRow): Promise<ShadowRunRow> {
  const db = getDb();
  const [row] = await db.insert(shadowRuns).values(run).returning();
  return row!;
}

export async function listShadowRuns(limit = 100): Promise<ShadowRunRow[]> {
  const db = getDb();
  return db.select().from(shadowRuns).orderBy(desc(shadowRuns.ranAt)).limit(limit);
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
export async function shadowStatsByClass(): Promise<ShadowClassStats[]> {
  const db = getDb();
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
export async function listShadowRunsForClass(drugClass: string, limit = 100): Promise<ShadowRunRow[]> {
  const db = getDb();
  return db
    .select()
    .from(shadowRuns)
    .where(eq(shadowRuns.drugClass, drugClass))
    .orderBy(desc(shadowRuns.ranAt))
    .limit(limit);
}
