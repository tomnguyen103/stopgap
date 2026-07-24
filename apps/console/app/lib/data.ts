import "server-only";
import {
  getCaseByWorkflowId,
  getDb,
  listCases,
  listShadowRuns,
  schema,
  shadowStatsByClass,
} from "@stopgap/db";
import type {
  AuditRow,
  CaseRow,
  ProtocolRow,
  ProtocolVersionRow,
  ShadowClassStats,
  ShadowRunRow,
} from "@stopgap/db";
import { evaluatePromotion, type PromotionDecision } from "@stopgap/shadow";
import { desc, eq } from "drizzle-orm";

/** All cases, newest-touched first (list view). */
export async function getCases(): Promise<CaseRow[]> {
  return listCases(getDb(), 200);
}

/** One case plus its hash-chained audit trail (detail view). */
export async function getCaseDetail(
  workflowId: string,
): Promise<{ case: CaseRow; audit: AuditRow[] } | undefined> {
  const db = getDb();
  const row = await getCaseByWorkflowId(db, workflowId);
  if (!row) return undefined;
  const audit = await db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.caseId, row.id))
    .orderBy(desc(schema.auditLog.id));
  return { case: row, audit };
}

/** Shadow-mode aggregates per drug class, with the promotion stage each has earned. */
export async function getShadowDashboard(): Promise<
  { stats: ShadowClassStats; decision: PromotionDecision }[]
> {
  const stats = await shadowStatsByClass();
  return stats
    .map((s) => ({ stats: s, decision: evaluatePromotion(s) }))
    .sort((a, b) => b.stats.runs - a.stats.runs);
}

/** The most recent shadow runs, for disagreement triage. */
export async function getShadowRuns(limit = 50): Promise<ShadowRunRow[]> {
  return listShadowRuns(limit);
}

/** Every version of every protocol the organization has approved, newest first. */
export async function getProtocols(): Promise<
  { protocol: ProtocolRow; versions: ProtocolVersionRow[] }[]
> {
  const db = getDb();
  const rows = await db.select().from(schema.protocols).orderBy(desc(schema.protocols.updatedAt));
  if (rows.length === 0) return [];
  // One query for every version, grouped in memory — a per-protocol lookup would re-find the
  // protocol row this function already holds, twice per protocol per page render.
  const versions = await db
    .select()
    .from(schema.protocolVersions)
    .orderBy(desc(schema.protocolVersions.version));
  return rows.map((protocol) => ({
    protocol,
    versions: versions.filter((version) => version.protocolId === protocol.id),
  }));
}
