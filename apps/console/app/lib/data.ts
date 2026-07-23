import "server-only";
import { getCaseByWorkflowId, getDb, listCases, schema } from "@stopgap/db";
import type { AuditRow, CaseRow } from "@stopgap/db";
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
