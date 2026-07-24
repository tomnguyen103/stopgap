import type { CaseStatus, Severity, ShortageRecord } from "@stopgap/core";
import { desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { cases, type CaseRow } from "./schema.js";

/**
 * Statuses in which a case is actively watching the feed for its shortage to end — the only
 * cases feed-resolution auto-detect (PHASE6 §6.6) touches. A case earlier in its lifecycle is
 * not yet monitoring, and a terminal case is done; signalling either would be wrong.
 */
export const MONITORING_STATUSES: readonly CaseStatus[] = ["monitoring"];

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

export async function listCases(db: Db, limit = 100): Promise<CaseRow[]> {
  return db.select().from(cases).orderBy(desc(cases.updatedAt)).limit(limit);
}

/** A monitoring case as the feed-resolution diff needs it (PHASE6 §6.6). */
export interface OpenMonitoringCase {
  caseId: string;
  key: string;
  source: string;
  sourceId: string;
  feedMissCount: number;
}

/** Open cases in a monitoring status, for the poll's resolution diff. */
export async function listOpenMonitoringCases(db: Db): Promise<OpenMonitoringCase[]> {
  return db
    .select({
      caseId: cases.id,
      key: cases.key,
      source: cases.source,
      sourceId: cases.sourceId,
      feedMissCount: cases.feedMissCount,
    })
    .from(cases)
    .where(inArray(cases.status, [...MONITORING_STATUSES]));
}

/**
 * Increment a case's consecutive-miss counter by one. Done in SQL (not read-modify-write) so
 * concurrent polls cannot lose an increment against each other.
 */
export async function bumpFeedMiss(db: Db, caseId: string): Promise<void> {
  // Counter-only writes deliberately leave `updatedAt` alone: a silent miss-count is not a
  // case state change, and touching it would bubble every monitoring case to the top of the
  // console's newest-first list on every 15-minute poll.
  await db
    .update(cases)
    .set({ feedMissCount: sql`${cases.feedMissCount} + 1` })
    .where(eq(cases.id, caseId));
}

/** Reset a case's miss counter to zero (key reappeared, or resolution fired). */
export async function resetFeedMiss(db: Db, caseId: string): Promise<void> {
  await db.update(cases).set({ feedMissCount: 0 }).where(eq(cases.id, caseId));
}
