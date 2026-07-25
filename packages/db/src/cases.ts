import type { CaseStatus, Severity, ShortageRecord } from "@stopgap/core";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { cases, type CaseRow } from "./schema.js";

/**
 * Statuses in which a case is actively watching the feed for its shortage to end — the only
 * cases feed-resolution auto-detect (PHASE6 §6.6) touches. A case earlier in its lifecycle is
 * not yet monitoring, and a terminal case is done; signalling either would be wrong.
 */
export const MONITORING_STATUSES: readonly CaseStatus[] = ["monitoring"];

/**
 * ORG SCOPING (PHASE6 §6.5) — the rationale for every `orgId` parameter in this file and in
 * `protocols.ts`, `shadow.ts`, `demo-runs.ts`, `metrics.ts`, `ops-metrics.ts`, `escalation.ts`,
 * `api-keys.ts` and `users.ts`.
 *
 * Row-level security already makes another tenant's rows invisible on an org-scoped connection,
 * so these explicit `eq(table.orgId, orgId)` filters are, strictly speaking, redundant. They are
 * here on purpose, and the redundancy is the point — belt and braces, with each layer catching a
 * different failure:
 *
 *  - RLS is the BACKSTOP. It is what makes an application-layer bug non-catastrophic: even a
 *    query that forgets its org filter entirely cannot return another hospital's data, because
 *    the database refuses before the rows ever reach Node.
 *  - The explicit filter is what makes that bug VISIBLE. A query that loses its scope returns
 *    zero rows, and zero rows is a failing test and an empty page someone reports — a bug we get
 *    to see. Relying on RLS alone would make the same bug silent, indistinguishable from correct
 *    behaviour right up until the day something runs as a role that bypasses the policies.
 *
 * Hence the standing rule for this package: pass an org-scoped `Db` from `withOrgDb` AND keep the
 * explicit org predicate. Neither substitutes for the other.
 */

/**
 * Deterministic Temporal workflow id for a NEW case, derived from the owning org and the dedup key
 * (PHASE6 §6.5, pass 2): `org-<orgId>-case-<key>`.
 *
 * WHY THE ORG IS IN THE ID AT ALL. Temporal workflow ids are unique per NAMESPACE, not per tenant,
 * and `case-heparin` is what every hospital short on heparin computes. Without the org prefix the
 * second tenant's detection would collide with the first tenant's running workflow, and the
 * `WorkflowExecutionAlreadyStartedError` that `startCase` treats as "already open" would silently
 * mean "another hospital has this open" — one org's clinical case suppressing another's. The
 * database's `(org_id, workflow_id)` unique index already allowed the two rows; this is the other
 * half of the same fix, on the engine side.
 *
 * WHAT THIS FUNCTION IS NOT. It is NOT a way to look a case up. Rows written before this pass hold
 * the OLD `case-<key>` id in `cases.workflow_id`, and a workflow started under that id still
 * answers to it — Temporal has no rename. Recomputing an id to find a case would therefore make
 * every pre-migration case unreachable the moment this format changed. Lookups go through
 * `getCaseByKey(db, orgId, key)` and use the `workflowId` the ROW carries; this function is only
 * for minting the id of a case that does not exist yet. `packages/db/src/cases.test.ts` pins that
 * behaviour so the rule cannot rot back.
 */
export function workflowIdForKey(orgId: string, key: string): string {
  return `org-${orgId}-case-${key.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
}

/**
 * Insert the case row for a newly detected shortage, or return the existing row if a case
 * for this key already exists (idempotent — the workflow may replay this).
 */
export async function upsertCaseForRecord(db: Db, orgId: string, record: ShortageRecord): Promise<CaseRow> {
  // KEY FIRST, id second (PHASE6 §6.5 pass 2). A case row written before the workflow-id format
  // changed holds the old `case-<key>` id, so arbitrating only on the NEWLY computed
  // `org-<orgId>-case-<key>` would find no conflict for it. Migration 0014's `cases_key_uq` — UNIQUE
  // on `(org_id, key)` — means the insert below would then RAISE rather than silently duplicate, but
  // raising is still the wrong answer: the org does have a case for this drug, and the caller asked
  // for it. The `(org_id, key)` read finds legacy-format rows and returns them, which is the
  // identity question this function actually asks; the insert is only for a case that does not exist.
  const existingByKey = await getCaseByKey(db, orgId, record.key);
  if (existingByKey) return existingByKey;
  const workflowId = workflowIdForKey(orgId, record.key);
  const [row] = await db
    .insert(cases)
    .values({
      orgId,
      workflowId,
      key: record.key,
      genericName: record.genericName,
      source: record.source,
      sourceId: record.sourceId,
      status: "detected",
      ndcs: record.ndcs,
    })
    // The conflict target is the WIDENED (org_id, workflow_id) unique index: two orgs legitimately
    // compute the same `case-heparin` workflow id, so arbitrating on `workflow_id` alone would
    // make the second hospital's detection collide with the first hospital's case.
    .onConflictDoNothing({ target: [cases.orgId, cases.workflowId] })
    .returning();
  if (row) return row;
  const existing = await getCaseByWorkflowId(db, orgId, workflowId);
  if (!existing) throw new Error(`case upsert raced and vanished for ${orgId}/${workflowId}`);
  return existing;
}

export async function getCaseByWorkflowId(
  db: Db,
  orgId: string,
  workflowId: string,
): Promise<CaseRow | undefined> {
  const [row] = await db
    .select()
    .from(cases)
    .where(and(eq(cases.orgId, orgId), eq(cases.workflowId, workflowId)))
    .limit(1);
  return row;
}

/**
 * The case for a shortage KEY, rather than for a workflow id (PHASE6 §6.5).
 *
 * THE ONLY CORRECT WAY to find a case from a key. `workflowIdForKey` now returns the org-qualified
 * `org-<orgId>-case-<key>`, but every case row written before that change still carries the old
 * `case-<key>` value in `cases.workflow_id` — so a lookup that recomputed the id would miss every
 * pre-migration case and report "no such case" for shortages the console is actively displaying.
 * Addressing the `(org_id, key)` index instead is format-independent: it answers the question the
 * caller actually has ("this org's case for this drug") rather than a question about id spelling.
 * Callers that then need to reach Temporal use the `workflowId` on the ROW they got back.
 *
 * The `.limit(1)` with no `ORDER BY` is deterministic because `cases_key_uq` is UNIQUE on
 * `(org_id, key)` since migration 0014 — at most one row can match, so there is nothing to order.
 * That was NOT true when the index was merely `cases_key_idx`: uniqueness was maintained by the
 * convention that `upsertCaseForRecord` reads before it writes, and two concurrent detections
 * interleaving would have made this return an arbitrary one of two rows, differing between calls.
 */
export async function getCaseByKey(db: Db, orgId: string, key: string): Promise<CaseRow | undefined> {
  const [row] = await db
    .select()
    .from(cases)
    .where(and(eq(cases.orgId, orgId), eq(cases.key, key)))
    .limit(1);
  return row;
}

/**
 * Many cases by key, in ONE query (PHASE6 §6.5). The feed poll's prefetch.
 *
 * Exists because the poll previously asked `getCaseByKey` once per (organization, shortage) — each
 * one its own `withOrgDb`, and therefore its own transaction and its own checkout from a `max: 10`
 * pool. At a hundred shortages across fifty tenants that is five thousand transactions per poll, on
 * a pool that can serve ten at a time. One `inArray` read per org replaces the whole inner loop.
 *
 * `(org_id, key)` is unique, so the returned rows are one-per-key and a caller can index them
 * directly without deciding what a duplicate would mean.
 */
export async function getCasesByKeys(db: Db, orgId: string, keys: string[]): Promise<CaseRow[]> {
  if (keys.length === 0) return [];
  return db
    .select()
    .from(cases)
    .where(and(eq(cases.orgId, orgId), inArray(cases.key, keys)));
}

export async function updateCaseStatus(
  db: Db,
  orgId: string,
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
    .where(and(eq(cases.orgId, orgId), eq(cases.workflowId, workflowId)));
}

export async function listCases(db: Db, orgId: string, limit = 100): Promise<CaseRow[]> {
  return db.select().from(cases).where(eq(cases.orgId, orgId)).orderBy(desc(cases.updatedAt)).limit(limit);
}

/** A monitoring case as the feed-resolution diff needs it (PHASE6 §6.6). */
export interface OpenMonitoringCase {
  caseId: string;
  /**
   * The id Temporal knows this case's workflow by (PHASE6 §6.5). Carried rather than recomputed
   * because a case opened before the org-qualified format still answers to `case-<key>`, and the
   * poll's resolution signal has to reach the execution that actually exists.
   */
  workflowId: string;
  key: string;
  source: string;
  sourceId: string;
  feedMissCount: number;
}

/** Open cases in a monitoring status, for the poll's resolution diff. */
export async function listOpenMonitoringCases(db: Db, orgId: string): Promise<OpenMonitoringCase[]> {
  return db
    .select({
      caseId: cases.id,
      workflowId: cases.workflowId,
      key: cases.key,
      source: cases.source,
      sourceId: cases.sourceId,
      feedMissCount: cases.feedMissCount,
    })
    .from(cases)
    .where(and(eq(cases.orgId, orgId), inArray(cases.status, [...MONITORING_STATUSES])));
}

/**
 * Increment a case's consecutive-miss counter by one, idempotently per poll run. Done in SQL
 * (not read-modify-write) so concurrent polls cannot lose an increment; guarded on
 * `lastFeedPollRun IS DISTINCT FROM runId` so a RETRY of the same at-least-once poll is a
 * no-op (the run already bumped this case) while a genuinely later poll still increments.
 * Without the guard, a retry after a partial failure would double-count and resolve early.
 */
export async function bumpFeedMiss(db: Db, orgId: string, caseId: string, runId: string): Promise<void> {
  // Counter-only writes deliberately leave `updatedAt` alone: a silent miss-count is not a
  // case state change, and touching it would bubble every monitoring case to the top of the
  // console's newest-first list on every 15-minute poll.
  await db
    .update(cases)
    .set({ feedMissCount: sql`${cases.feedMissCount} + 1`, lastFeedPollRun: runId })
    .where(
      and(
        eq(cases.orgId, orgId),
        eq(cases.id, caseId),
        sql`${cases.lastFeedPollRun} is distinct from ${runId}`,
      ),
    );
}

/** Reset a case's miss counter to zero (key reappeared, or resolution fired). */
export async function resetFeedMiss(db: Db, orgId: string, caseId: string): Promise<void> {
  await db.update(cases).set({ feedMissCount: 0 }).where(and(eq(cases.orgId, orgId), eq(cases.id, caseId)));
}
