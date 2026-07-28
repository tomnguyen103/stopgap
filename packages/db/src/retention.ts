import { and, eq, inArray, lt } from "drizzle-orm";

import { withOrgDb } from "./org-context.js";
import { appendAudit } from "./audit.js";
import {
  alertEvents,
  inventorySnapshots,
  procurementEvents,
  riskScoreSnapshots,
  riskSignals,
} from "./schema.js";

/**
 * Retention (ticket 18) — the sweep that keeps a long-running deployment from degrading.
 *
 * Every poll writes signals and snapshots, and every alert evaluation writes an event whether or
 * not it notified. Nothing above removes them, so the tables that grow fastest are exactly the
 * ones a deployment never looks at again after a few months. This module removes what is past its
 * window, and does so under four constraints that shape everything below:
 *
 *  1. **The audit chain is not sweepable, at any window.** It is hash-linked and externally
 *     anchored: removing an entry does not reclaim meaningful space, it makes every later entry
 *     unverifiable and makes the next anchor comparison report tampering that never happened. So
 *     `auditLog` and `auditAnchors` are not retention KINDS — there is no window that could turn
 *     them on, rather than a default that happens to be off.
 *  2. **Tenant-scoped.** The sweep runs inside `withOrgDb` per organization, so RLS refuses a
 *     cross-tenant row even if a predicate here were wrong. One tenant's retention policy can
 *     never reach another tenant's rows.
 *  3. **Interruptible.** Deletion is BATCHED, each batch its own statement, and every batch is
 *     independently valid: a sweep killed halfway has removed some expired rows and no live ones.
 *     There is no intermediate state to resume from and nothing to roll back.
 *  4. **Recorded.** A run that removed nothing and a run that never happened look identical from
 *     the outside, so each org's sweep appends ONE audit entry with its per-kind counts — through
 *     the chain that already exists rather than a second bespoke log.
 */

/** The record kinds a sweep may remove. Deliberately does NOT include the audit chain — see above. */
export const RETENTION_KINDS = [
  "riskSignals",
  "riskScoreSnapshots",
  "alertEvents",
  "inventorySnapshots",
  "procurementEvents",
] as const;

export type RetentionKind = (typeof RETENTION_KINDS)[number];

/**
 * The window value meaning "keep indefinitely".
 *
 * Spelled as its own constant rather than as `0`, because 0 days reads to the arithmetic as
 * "cutoff = now", which sweeps the entire table. An operator who wants a kind left alone must be
 * able to say so without the difference between "keep everything" and "delete everything" being
 * one character.
 */
export const RETAINED_FOREVER = null;

export type RetentionWindows = Record<RetentionKind, number | typeof RETAINED_FOREVER>;

export interface RetentionPlanEntry {
  kind: RetentionKind;
  /** Rows strictly older than this are removable. */
  cutoff: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Turn configured windows into cutoff instants. Pure: no clock of its own, so a sweep's decisions
 * are reproducible from the run's recorded timestamp.
 */
export function retentionPlan(now: Date, windows: RetentionWindows): RetentionPlanEntry[] {
  const plan: RetentionPlanEntry[] = [];
  for (const kind of RETENTION_KINDS) {
    const days = windows[kind];
    if (days === RETAINED_FOREVER) continue;
    if (!Number.isFinite(days) || days < 0) {
      // A negative window puts the cutoff in the FUTURE, which sweeps rows that have not aged yet
      // — in practice, all of them. Refusing loudly beats a job that silently empties a table.
      throw new Error(`retention window for ${kind} must be a non-negative number of days, got ${days}`);
    }
    plan.push({ kind, cutoff: new Date(now.getTime() - days * DAY_MS) });
  }
  return plan;
}

/**
 * How many rows one DELETE removes.
 *
 * Batched rather than one statement per kind, because the first sweep of a deployment that has run
 * for a year would otherwise lock a large table for the duration of a single enormous delete. Each
 * batch commits on its own, so an interrupted sweep leaves a consistent database and the next run
 * simply continues.
 */
export const RETENTION_BATCH_SIZE = 5_000;

/** What one org's sweep removed, per kind. Kinds that removed nothing are still reported as 0. */
export type RetentionCounts = Record<RetentionKind, number>;

/**
 * Delete one kind's expired rows for one tenant, in batches, returning how many went.
 *
 * The `id in (select … limit)` shape is what makes the batch bounded: a bare `delete … where
 * captured_at < cutoff` is unbounded by construction. `orgId` appears in BOTH the subquery and the
 * outer predicate — belt and braces over RLS, so a row this tenant cannot see is also a row this
 * statement does not name.
 */
async function sweepKind(
  db: Parameters<Parameters<typeof withOrgDb>[1]>[0],
  orgId: string,
  kind: RetentionKind,
  cutoff: Date,
): Promise<number> {
  const table = {
    riskSignals: { table: riskSignals, id: riskSignals.id, org: riskSignals.orgId, at: riskSignals.publishedAt },
    riskScoreSnapshots: {
      table: riskScoreSnapshots,
      id: riskScoreSnapshots.id,
      org: riskScoreSnapshots.orgId,
      at: riskScoreSnapshots.computedAt,
    },
    alertEvents: { table: alertEvents, id: alertEvents.id, org: alertEvents.orgId, at: alertEvents.firedAt },
    inventorySnapshots: {
      table: inventorySnapshots,
      id: inventorySnapshots.id,
      org: inventorySnapshots.orgId,
      at: inventorySnapshots.capturedAt,
    },
    procurementEvents: {
      table: procurementEvents,
      id: procurementEvents.id,
      org: procurementEvents.orgId,
      at: procurementEvents.orderedAt,
    },
  }[kind];

  let removed = 0;
  for (;;) {
    const doomed = await db
      .select({ id: table.id })
      .from(table.table)
      .where(and(eq(table.org, orgId), lt(table.at, cutoff)))
      .limit(RETENTION_BATCH_SIZE);
    if (doomed.length === 0) return removed;
    await db
      .delete(table.table)
      .where(
        and(
          eq(table.org, orgId),
          inArray(
            table.id,
            doomed.map((row) => row.id),
          ),
        ),
      );
    removed += doomed.length;
    // A short batch means the table is drained; skipping the confirming round trip matters on the
    // common case where nothing at all has expired.
    if (doomed.length < RETENTION_BATCH_SIZE) return removed;
  }
}

export interface RetentionSweepResult {
  orgId: string;
  counts: RetentionCounts;
  /** The instant the plan was computed from — the run is reproducible from it. */
  sweptAt: Date;
}

/**
 * Sweep one organization, then record what it removed in that organization's audit chain.
 *
 * Deleting `riskSignals` cascades to their snapshots, so the snapshot count reported here is only
 * the snapshots removed by their OWN window — a signal removed with its history contributes to the
 * signal count and not to the snapshot one. Reporting the cascade separately would double-count
 * rows and make the two numbers unaddable.
 */
export async function sweepOrgRetention(
  orgId: string,
  now: Date,
  windows: RetentionWindows,
): Promise<RetentionSweepResult> {
  const plan = retentionPlan(now, windows);
  const counts = Object.fromEntries(RETENTION_KINDS.map((kind) => [kind, 0])) as RetentionCounts;

  // Each kind in its OWN transaction, so an interruption between two kinds leaves the database
  // consistent and the work already done committed. A single transaction spanning every kind would
  // make a killed sweep undo hours of deletes and start again from nothing.
  for (const entry of plan) {
    counts[entry.kind] = await withOrgDb(orgId, (db) => sweepKind(db, orgId, entry.kind, entry.cutoff));
  }

  await withOrgDb(orgId, (db) =>
    appendAudit(db, {
      orgId,
      actor: "system:retention",
      action: "retention.sweep",
      detail: {
        sweptAt: now.toISOString(),
        counts,
        cutoffs: Object.fromEntries(plan.map((entry) => [entry.kind, entry.cutoff.toISOString()])),
      },
      // One entry per org per sweep instant: a retried activity records the same run once rather
      // than appending a second entry claiming a second cleanup.
      eventKey: `retention:${orgId}:${now.toISOString()}`,
    }),
  );

  return { orgId, counts, sweptAt: now };
}

/** Total rows removed across kinds — the one number a run's log line reports. */
export function totalRemoved(counts: RetentionCounts): number {
  return RETENTION_KINDS.reduce((sum, kind) => sum + counts[kind], 0);
}
