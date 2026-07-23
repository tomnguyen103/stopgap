import type { CaseStatus, Severity, ShortageRecord } from "@stopgap/core";
import { desc, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { cases, type CaseRow } from "./schema.js";

/** Deterministic Temporal workflow id for a case, derived from the dedup key. */
export function workflowIdForKey(key: string): string {
  return `case-${key.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
}

/**
 * Insert the case row for a newly detected shortage, or return the existing row if a case
 * for this key already exists (idempotent — the workflow may replay this).
 */
export async function upsertCaseForRecord(db: Db, record: ShortageRecord): Promise<CaseRow> {
  const workflowId = workflowIdForKey(record.key);
  const [row] = await db
    .insert(cases)
    .values({
      workflowId,
      key: record.key,
      genericName: record.genericName,
      source: record.source,
      sourceId: record.sourceId,
      status: "detected",
      ndcs: record.ndcs,
    })
    .onConflictDoNothing({ target: cases.workflowId })
    .returning();
  if (row) return row;
  const existing = await getCaseByWorkflowId(db, workflowId);
  if (!existing) throw new Error(`case upsert raced and vanished for ${workflowId}`);
  return existing;
}

export async function getCaseByWorkflowId(db: Db, workflowId: string): Promise<CaseRow | undefined> {
  const [row] = await db.select().from(cases).where(eq(cases.workflowId, workflowId)).limit(1);
  return row;
}

export async function updateCaseStatus(
  db: Db,
  workflowId: string,
  status: CaseStatus,
  patch: { severity?: Severity; lastNote?: string; closedAt?: Date } = {},
): Promise<void> {
  await db
    .update(cases)
    .set({
      status,
      severity: patch.severity,
      lastNote: patch.lastNote,
      closedAt: patch.closedAt,
      updatedAt: new Date(),
    })
    .where(eq(cases.workflowId, workflowId));
}

export async function listCases(db: Db, limit = 100): Promise<CaseRow[]> {
  return db.select().from(cases).orderBy(desc(cases.updatedAt)).limit(limit);
}
