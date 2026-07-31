import { asc, eq, sql } from "drizzle-orm";

import { connectorRuns, type ConnectorRunRow } from "./schema.js";
import type { Db } from "./client.js";

/**
 * Per-tenant connector health (ticket 17) — "so a silent feed is noticed".
 *
 * The administrator's surface already had a feed panel, but it read `feed_records`, which is
 * DEPLOYMENT-wide and is only written by the two shortage connectors. It could therefore say the
 * deployment had heard from openFDA; it could not say whether THIS hospital got signals out of that
 * poll, and it could say nothing at all about the recall connectors. This module records the other
 * half: what each connector did for one tenant on its most recent run.
 *
 * Scoped `Db` AND an explicit `orgId` on every call, like every other helper here — RLS is the
 * backstop and the predicate is what turns a lost scope into an empty panel somebody reports.
 */

/**
 * How a connector's run ended, for one tenant.
 *
 * Three values rather than a boolean, because the two failures need different responses and a
 * single `failed` would hide which one happened. `fetch_failed` is the SOURCE being unreachable and
 * is the same for every tenant in the deployment; `persist_failed` is this tenant's own write
 * failing, which is a database problem for one hospital while every other one is fine.
 */
export const CONNECTOR_RUN_OUTCOMES = ["ok", "fetch_failed", "persist_failed"] as const;

export type ConnectorRunOutcome = (typeof CONNECTOR_RUN_OUTCOMES)[number];

export interface ConnectorRunInput {
  source: string;
  outcome: ConnectorRunOutcome;
  /** Normalized signals this connector produced for this tenant on this run. */
  signalCount: number;
  /** The failure, when there was one. Omitted on an ordinary run. */
  detail?: string;
}

/**
 * Record this poll's runs for one tenant, replacing the previous entry per connector.
 *
 * ONE STATEMENT for the whole set, and an UPSERT rather than an insert: the table holds the LATEST
 * run per `(org, source)`, so a poll restates the row it already has instead of appending. That is
 * what keeps this bounded at tenants × feeds and out of the retention schedule entirely.
 *
 * `lastOkAt` is advanced ONLY by a successful run — on a failure the stored value is kept, which is
 * the whole reason it is a separate column from `ranAt`. `excluded.last_ok_at` is the incoming
 * value (the run time on success, NULL on failure), so `coalesce(excluded, existing)` keeps the
 * previous success rather than erasing it, and a connector that has never succeeded stays NULL.
 */
export async function recordConnectorRuns(
  db: Db,
  orgId: string,
  ranAt: Date,
  runs: ConnectorRunInput[],
): Promise<void> {
  if (runs.length === 0) return;
  await db
    .insert(connectorRuns)
    .values(
      runs.map((run) => ({
        orgId,
        source: run.source,
        ranAt,
        outcome: run.outcome,
        signalCount: run.signalCount,
        lastOkAt: run.outcome === "ok" ? ranAt : null,
        detail: run.detail ?? null,
      })),
    )
    .onConflictDoUpdate({
      target: [connectorRuns.orgId, connectorRuns.source],
      set: {
        ranAt: sql`excluded.ran_at`,
        outcome: sql`excluded.outcome`,
        signalCount: sql`excluded.signal_count`,
        lastOkAt: sql`coalesce(excluded.last_ok_at, ${connectorRuns.lastOkAt})`,
        detail: sql`excluded.detail`,
      },
    });
}

/**
 * This tenant's connectors, ordered by source so the panel does not reshuffle between page loads.
 *
 * A connector that has NEVER run for this tenant has no row and is therefore absent — which the
 * console has to say out loud rather than render as an empty table, because "no row" and "healthy"
 * are the two readings a silent feed sits exactly between.
 */
export async function listConnectorRuns(db: Db, orgId: string): Promise<ConnectorRunRow[]> {
  return db
    .select()
    .from(connectorRuns)
    .where(eq(connectorRuns.orgId, orgId))
    .orderBy(asc(connectorRuns.source));
}
