import type { CaseStatus, Severity, ShortageRecord } from "@stopgap/core";
import { and, count, desc, eq, gte, like } from "drizzle-orm";
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
  patch: { severity?: Severity; lastNote?: string; closedAt?: Date; openedAt?: Date } = {},
): Promise<void> {
  await db
    .update(cases)
    .set({
      status,
      severity: patch.severity,
      lastNote: patch.lastNote,
      closedAt: patch.closedAt,
      // Only the demo seeder passes this, to place a case at a believable point in its
      // lifecycle ("day 18"); real cases keep the timestamp their first detection wrote.
      openedAt: patch.openedAt,
      updatedAt: new Date(),
    })
    .where(eq(cases.workflowId, workflowId));
}

/**
 * How many cases from a given source-id prefix were opened since `since`. Backs the demo
 * scenario rate limit (PROJECT_PLAN §11): the count comes from the case table rather than a
 * process-local counter so the limit survives a restart and holds across replicas.
 */
export async function countCasesOpenedSince(
  db: Db,
  sourceIdPrefix: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(cases)
    .where(and(like(cases.sourceId, `${sourceIdPrefix}%`), gte(cases.openedAt, since)));
  return row?.n ?? 0;
}

export async function listCases(db: Db, limit = 100): Promise<CaseRow[]> {
  return db.select().from(cases).orderBy(desc(cases.updatedAt)).limit(limit);
}
