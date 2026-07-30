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
 *     the outside, so each org's sweep appends an audit entry with its per-kind counts — through
 *     the chain that already exists rather than a second bespoke log.
 *
 * ONE WINDOW IS NOT INDEPENDENT OF ANOTHER, and the configuration cannot hide it: score snapshots
 * cascade from their signal, so a snapshot window LONGER than the signal window does not preserve
 * them — a swept signal takes its history with it. The snapshot window governs snapshots whose
 * signal is still here; it cannot outlive the signal, and no setting makes it.
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
 * The table, tenant column, and AGE column behind each kind — one map, at module level.
 *
 * Age is read from the column that says how long the row has been ours, not from a date the
 * SOURCE chose: `risk_signals.updatedAt` is refreshed by every poll that still sees the signal, so
 * a shortage published two years ago and still live is not swept, while one the feeds stopped
 * mentioning ages out. Sweeping on `publishedAt` would delete live signals and the next poll would
 * recreate them with their miss counters reset — churn that looks like retention working.
 */
const RETENTION_TABLES = {
  riskSignals: { table: riskSignals, id: riskSignals.id, org: riskSignals.orgId, at: riskSignals.updatedAt },
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
} as const satisfies Record<RetentionKind, unknown>;

/**
 * Delete one kind's expired rows for one tenant, in batches, returning how many went.
 *
 * ONE TRANSACTION PER BATCH — `withOrgDb` opens the transaction, and it is opened INSIDE the loop
 * on purpose. A scope around the whole loop would hold every deleted row's lock until the last
 * batch committed, which is the single enormous delete the batching exists to avoid, and a sweep
 * killed halfway would roll back all of its work. As written, each batch commits alone: an
 * interrupted sweep has removed some expired rows and no live ones, with nothing to resume.
 *
 * The `id in (…)` shape is what makes a batch bounded — a bare `delete … where at < cutoff` is
 * unbounded by construction. `orgId` is in both the select and the delete: RLS would already hide
 * another tenant's row, and the predicate means the statement does not name it either.
 */
/**
 * `onBatch` is called after EVERY committed batch, not once at the end, for two reasons that
 * both bite on the first sweep of an aged deployment: the caller's per-kind count then survives a
 * throw from a later batch (rows already deleted are gone, and a count that resets to 0 tells the
 * audit chain the opposite of what happened), and the caller gets somewhere to heartbeat from
 * inside a loop that can otherwise run for many minutes without one.
 */
async function sweepKind(
  orgId: string,
  kind: RetentionKind,
  cutoff: Date,
  onBatch: (removed: number) => void,
): Promise<number> {
  const columns = RETENTION_TABLES[kind];
  let removed = 0;
  for (;;) {
    const batch = await withOrgDb(orgId, async (db) => {
      const doomed = await db
        .select({ id: columns.id })
        .from(columns.table)
        .where(and(eq(columns.org, orgId), lt(columns.at, cutoff)))
        .limit(RETENTION_BATCH_SIZE);
      if (doomed.length === 0) return { selected: 0, deleted: 0 };
      const gone = await db.delete(columns.table).where(
        and(
          eq(columns.org, orgId),
          // The AGE PREDICATE IS RESTATED HERE, not just the ids the select returned. Between the
          // two statements a row can be touched — a signal re-fetched, an alert event amended —
          // and its age column moved forward past the cutoff. Deleting on ids alone would then
          // remove a row that is no longer expired, which is the one thing a retention sweep must
          // never do: it deletes on a fact it checked before that fact changed.
          lt(columns.at, cutoff),
          inArray(
            columns.id,
            doomed.map((row) => row.id),
          ),
        ),
      ).returning({ id: columns.id });
      // Two numbers, deliberately. `deleted` is what was REMOVED and is what the audit entry and
      // the counters report; `selected` is what the page held and is what decides whether the
      // table is drained. They differ exactly when a row aged out from under the sweep, and
      // conflating them would either over-report a deletion that did not happen or stop the loop
      // early on a full page.
      return { selected: doomed.length, deleted: gone.length };
    });
    removed += batch.deleted;
    if (batch.deleted > 0) onBatch(batch.deleted);
    // A short batch means the table is drained; the confirming round trip is skipped, which is the
    // common case where nothing at all has expired.
    if (batch.selected < RETENTION_BATCH_SIZE) return removed;
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
  /**
   * A token identifying the RUN, stable across retries of the same execution (the Temporal run id
   * upstream). It names the sweep in the audit entry, so two entries produced by a retried
   * activity are recognisable as one sweep recorded twice rather than as two cleanups.
   */
  runToken = now.toISOString(),
  /**
   * Called after every committed batch. The caller uses it to heartbeat: this function's runtime
   * is unbounded in the size of the tenant, so a sweep that only reported at the end would look
   * like a dead worker to Temporal long before it finished.
   */
  onProgress?: (kind: RetentionKind, removedSoFar: number) => void,
): Promise<RetentionSweepResult> {
  const plan = retentionPlan(now, windows);
  const counts = Object.fromEntries(RETENTION_KINDS.map((kind) => [kind, 0])) as RetentionCounts;

  try {
    for (const entry of plan) {
      await sweepKind(orgId, entry.kind, entry.cutoff, (removed) => {
        counts[entry.kind] += removed;
        onProgress?.(entry.kind, counts[entry.kind]);
      });
    }
  } finally {
    // Recorded even when a later kind threw. Rows already deleted are gone whether or not the run
    // finished, and an audit chain that only describes complete runs cannot answer "where did
    // those rows go" for the runs that matter most.
    //
    // GUARDED, because an await in a `finally` that throws REPLACES the exception on its way out:
    // a failed audit write would otherwise mask the sweep error that is the actual problem, and
    // the caller would diagnose the wrong failure. Losing the audit row is bad; losing the reason
    // the sweep died is worse, so the audit failure is logged and the original error propagates.
    try {
    await withOrgDb(orgId, (db) =>
      appendAudit(db, {
        orgId,
        actor: "system:retention",
        action: "retention.sweep",
        detail: {
          sweptAt: now.toISOString(),
          runToken,
          counts,
          cutoffs: Object.fromEntries(plan.map((entry) => [entry.kind, entry.cutoff.toISOString()])),
        },
        // NOT deduped: `appendAudit` only applies its idempotency lookup to case-scoped entries,
        // and this has no case. The key is a stable label, not a guarantee of one entry per run.
        eventKey: `retention:${orgId}:${runToken}`,
      }),
    );
    } catch (auditErr) {
      console.error(`[retention] org ${orgId}: sweep audit entry failed to write`, auditErr);
    }
  }

  return { orgId, counts, sweptAt: now };
}

/** Total rows removed across kinds — the one number a run's log line reports. */
export function totalRemoved(counts: RetentionCounts): number {
  return RETENTION_KINDS.reduce((sum, kind) => sum + counts[kind], 0);
}
