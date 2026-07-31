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

/** How much of a failure message is worth storing and showing. */
const DETAIL_MAX_CHARS = 500;

/**
 * How much of it the patterns below are allowed to run over.
 *
 * Bounds the SCAN as well as the output, which are different limits. A Postgres error can carry a
 * whole statement and a fetch failure can carry a response body, and four global regexes over
 * megabytes to produce 500 characters is work done for nothing. Everything past this point is
 * discarded either way — the output is cut twenty times shorter — so nothing readable is lost, and
 * a secret sitting beyond it could never have reached the page regardless.
 */
const DETAIL_SCAN_MAX_CHARS = 10_000;

/**
 * Credential-bearing shapes that turn up in the error text of an HTTP or SMTP client.
 *
 * `detail` is a raw `Error.message` from a network client, stored and then RENDERED on an
 * administrator's page — which makes it a disclosure surface, not just a log line. openFDA is
 * called with an API key in the query string and chat delivery with a bearer webhook URL, so a
 * client that ever echoes the request it failed on would put those on screen. Worse, one shared
 * fetch error is copied into EVERY tenant's row, so it would be on every hospital's page at once.
 *
 * Today's connectors report status codes only. This is here because the day one of them starts
 * echoing the URL is not a day anybody will remember this column exists.
 */
const REDACTIONS: [RegExp, string][] = [
  // Query parameters that carry a secret, by the names these clients actually use.
  [
    /\b(api[_-]?key|apikey|key|token|access[_-]?token|secret|password|pass|pwd|sig|signature)=[^&\s"']+/gi,
    "$1=[redacted]",
  ],
  // `scheme://user:password@host` — the credential is the part before the `@`.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@"],
  // `Authorization: Bearer …` and bare bearer tokens in a message.
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  // Slack, Teams and Discord webhook paths — the path segment IS the credential.
  [
    /(hooks\.slack\.com\/services|discord\.com\/api\/webhooks|webhook\.office\.com\/webhookb2)\/\S+/gi,
    "$1/[redacted]",
  ],
];

/**
 * Bound and redact a failure message before it is stored.
 *
 * Truncated as well as redacted: an unbounded provider error is a row that grows without limit and
 * a page that renders it, and 500 characters is well past where a status code and a reason stop
 * being useful. The ellipsis is deliberate — a silently cut message reads as the whole one.
 */
export function redactDetail(detail: string): string {
  const bounded = detail.slice(0, DETAIL_SCAN_MAX_CHARS);
  const clean = REDACTIONS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    bounded,
  );
  // Two ways to be truncated, and both must say so: the redacted text is still over the display
  // bound, or the input was long enough that the scan itself dropped a tail. Testing only the first
  // would mark a 20,000-character error as whole whenever redaction happened to shrink it under 500.
  return clean.length <= DETAIL_MAX_CHARS && bounded.length === detail.length
    ? clean
    : `${clean.slice(0, DETAIL_MAX_CHARS)}… (truncated)`;
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
        detail: run.detail === undefined ? null : redactDetail(run.detail),
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
      // A SLOW POLL MUST NOT REWIND A NEWER ONE. Two polls can overlap — a retried activity, or a
      // schedule firing while the previous run is still working through the tenant list — and
      // without this the one that COMMITS last wins regardless of which one RAN last, restamping a
      // stale failure over a fresh success. Equality is excluded too, so a retry of the same poll
      // (same `ranAt` for every org) is a no-op rather than a rewrite.
      setWhere: sql`${connectorRuns.ranAt} < excluded.ran_at`,
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
