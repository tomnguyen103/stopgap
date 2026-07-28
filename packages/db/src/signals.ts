import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";

import {
  riskScoreSnapshots,
  riskSignals,
  signalEvidence,
  type RiskSignalRow,
  type SignalEvidenceRow,
} from "./schema.js";
import type { Db } from "./client.js";

/**
 * The shape this module needs from a normalized signal.
 *
 * Declared structurally rather than imported from `@stopgap/ingest`, so the persistence layer does
 * not depend on the ingestion layer for a type. `NormalizedSignal` satisfies it; anything else
 * that can honestly fill these fields may too.
 */
export interface PersistableSignal {
  source: string;
  sourceId: string;
  riskDomain: string;
  entityType: string;
  entityIdentifier: string;
  title: string;
  summary: string;
  severity: string;
  severityScore: number;
  confidence: number;
  observedAt: string;
  publishedAt: string;
  lastFetchedAt: string;
  staleness: string;
  sourceResolved: boolean;
  evidenceUrl: string;
  raw: unknown;
  dedupeKey: string;
  matchHints: { ndcs: string[]; rxcuis: string[]; names: string[] };
}

/**
 * Reading and writing normalized signals, per tenant (ticket 06).
 *
 * Every function here takes BOTH a scoped `Db` (opened by `withOrgDb`, which has already set
 * `app.current_org`) AND an explicit `orgId`, and every predicate carries the org. That looks
 * redundant and is not: RLS is the backstop that makes an application bug non-catastrophic, and
 * the explicit filter is what makes the bug VISIBLE — a helper that loses its scope returns zero
 * rows, which is a failing test and an empty page someone reports, rather than silence. The same
 * belt-and-braces rule `docs/multi-tenancy.md` states for every other query helper.
 */

/** How many consecutive misses before the poller treats a signal as gone from the feed. */
export const FEED_ABSENT_THRESHOLD = 3;

/**
 * Collapse a batch onto one row per dedupe key, keeping the LAST occurrence.
 *
 * Not tidiness — `ON CONFLICT DO UPDATE` refuses to touch the same row twice in one statement
 * ("command cannot affect row a second time"), so a single repeated key aborts the whole tenant's
 * write rather than the one row. A feed can legitimately produce the repeat: the openFDA mapper
 * derives its `sourceId` from a hash of (generic name, presentation), and two records that agree
 * on both are the same signal reported twice.
 *
 * Last wins, because the feed orders its own records and the later one is the more recent
 * statement of the same hazard.
 */
export function dedupeByKey<T extends { dedupeKey: string }>(signals: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const signal of signals) byKey.set(signal.dedupeKey, signal);
  return [...byKey.values()];
}

/**
 * Insert or restate this tenant's signals, keyed on the contract's dedupe key.
 *
 * `feedMissCount` is reset to 0 on every upsert: the signal is in the feed right now, which is the
 * one fact that resets the miss counter. `sourceResolved` is written from the payload and NOT
 * inferred from presence — a terminated recall that still appears in the feed is resolved AND
 * present, and both halves have to survive the write.
 */
export async function upsertSignals(
  db: Db,
  orgId: string,
  signals: PersistableSignal[],
): Promise<{ id: string; dedupeKey: string }[]> {
  if (signals.length === 0) return [];
  const unique = dedupeByKey(signals);
  for (const signal of unique) {
    if (!signal.dedupeKey.startsWith(`${orgId}:`)) {
      // A signal normalized for ANOTHER tenant must never be written into this one.
      //
      // This check is the only thing that catches it. RLS will not: the insert below writes this
      // function's own `orgId` into the row, so `WITH CHECK` sees a row that belongs where it is
      // being put and passes — while the row's dedupe key still says it was computed for someone
      // else, which is a silent cross-tenant mix-up rather than a refused write.
      throw new Error(`signal ${signal.dedupeKey} was not normalized for org ${orgId}`);
    }
  }

  // ONE statement for the whole batch, not one per signal. A poll writes every signal a feed
  // returned, for every tenant, inside a single transaction — a round trip per row turns a
  // 200-signal feed across 50 tenants into 10,000 of them.
  return (
    db
      .insert(riskSignals)
      .values(
        unique.map((signal) => ({
          orgId,
          source: signal.source,
          sourceId: signal.sourceId,
          riskDomain: signal.riskDomain,
          entityType: signal.entityType,
          entityIdentifier: signal.entityIdentifier,
          title: signal.title,
          summary: signal.summary,
          severity: signal.severity,
          severityScore: signal.severityScore.toString(),
          confidence: signal.confidence.toString(),
          observedAt: new Date(signal.observedAt),
          publishedAt: new Date(signal.publishedAt),
          lastFetchedAt: new Date(signal.lastFetchedAt),
          staleness: signal.staleness,
          sourceResolved: signal.sourceResolved,
          feedMissCount: 0,
          evidenceUrl: signal.evidenceUrl,
          raw: signal.raw as Record<string, unknown>,
          dedupeKey: signal.dedupeKey,
          matchHints: signal.matchHints,
        })),
      )
      .onConflictDoUpdate({
        target: [riskSignals.orgId, riskSignals.dedupeKey],
        // `excluded` is the row this statement TRIED to insert — the only way to restate a batch
        // without a statement per row.
        set: {
          title: sql`excluded.title`,
          summary: sql`excluded.summary`,
          severity: sql`excluded.severity`,
          severityScore: sql`excluded.severity_score`,
          confidence: sql`excluded.confidence`,
          observedAt: sql`excluded.observed_at`,
          publishedAt: sql`excluded.published_at`,
          lastFetchedAt: sql`excluded.last_fetched_at`,
          staleness: sql`excluded.staleness`,
          sourceResolved: sql`excluded.source_resolved`,
          // Present in the feed right now — the one fact that resets the absence counter.
          feedMissCount: sql`0`,
          evidenceUrl: sql`excluded.evidence_url`,
          raw: sql`excluded.raw`,
          matchHints: sql`excluded.match_hints`,
          updatedAt: sql`now()`,
        },
      })
      // RETURNING covers inserted AND updated rows, which is what the caller needs: scoring attaches
      // a snapshot to every signal this poll saw, not only to the ones seen for the first time.
      .returning({ id: riskSignals.id, dedupeKey: riskSignals.dedupeKey })
  );
}

/**
 * Increment the miss counter for this tenant's signals that the current poll did NOT return.
 *
 * `lastFeedPollRun` guards the increment, exactly as the cases table's `bumpFeedMiss` does: the
 * poll is at-least-once, so a retry after a partial failure would otherwise count the same absence
 * twice and retire a live signal early.
 *
 * `polledSources` is what keeps a feed OUTAGE from looking like a feed telling us the hazard ended.
 * Only sources this poll actually reached are swept — a recall endpoint that was down returned no
 * signals, and counting every one of its rows as missing would retire live recalls after three
 * polls on the strength of a network failure.
 *
 * This is the FEED-ABSENT half. It never touches `sourceResolved` — a signal that vanished from
 * the feed has said nothing about whether the hazard is over.
 */
export async function bumpSignalFeedMiss(
  db: Db,
  orgId: string,
  seenDedupeKeys: string[],
  pollRun: string,
  polledSources: string[],
): Promise<number> {
  if (polledSources.length === 0) return 0;
  // `notInArray`, not a hand-written `not in ${array}`: the template form binds the whole array as
  // ONE parameter, so the predicate compares a text column against an array and matches nothing.
  const notSeen =
    seenDedupeKeys.length === 0 ? undefined : notInArray(riskSignals.dedupeKey, seenDedupeKeys);
  const rows = await db
    .update(riskSignals)
    .set({ feedMissCount: sql`${riskSignals.feedMissCount} + 1`, lastFeedPollRun: pollRun })
    .where(
      and(
        eq(riskSignals.orgId, orgId),
        inArray(riskSignals.source, polledSources),
        ...(notSeen ? [notSeen] : []),
        sql`${riskSignals.lastFeedPollRun} is distinct from ${pollRun}`,
      ),
    )
    .returning({ id: riskSignals.id });
  return rows.length;
}

export interface ListSignalsOptions {
  riskDomain?: string;
  /** Exclude signals the source has marked over. Off by default — they still carry weight. */
  excludeSourceResolved?: boolean;
  /** Exclude signals the feed has stopped listing for `FEED_ABSENT_THRESHOLD` polls. */
  excludeFeedAbsent?: boolean;
  limit?: number;
}

/** This tenant's signals, newest publication first. */
export async function listSignals(
  db: Db,
  orgId: string,
  options: ListSignalsOptions = {},
): Promise<RiskSignalRow[]> {
  const predicates = [eq(riskSignals.orgId, orgId)];
  if (options.riskDomain) predicates.push(eq(riskSignals.riskDomain, options.riskDomain));
  if (options.excludeSourceResolved) predicates.push(eq(riskSignals.sourceResolved, false));
  if (options.excludeFeedAbsent) {
    predicates.push(sql`${riskSignals.feedMissCount} < ${FEED_ABSENT_THRESHOLD}`);
  }
  return db
    .select()
    .from(riskSignals)
    .where(and(...predicates))
    .orderBy(desc(riskSignals.publishedAt))
    .limit(options.limit ?? 200);
}

/** One signal by its dedupe key, within this tenant. */
export async function getSignalByKey(
  db: Db,
  orgId: string,
  dedupeKey: string,
): Promise<RiskSignalRow | undefined> {
  const [row] = await db
    .select()
    .from(riskSignals)
    .where(and(eq(riskSignals.orgId, orgId), eq(riskSignals.dedupeKey, dedupeKey)))
    .limit(1);
  return row;
}

export interface ScoreSnapshotInput {
  signalId: string;
  score: number;
  band: string;
  components: Record<
    string,
    { points: number; max: number; available: boolean; unavailableReason?: string }
  >;
  /** The points this score could have earned — see the column comment on the table. */
  reachableMax: number;
  scorerVersion: string;
  /**
   * REQUIRED, not defaulted to the clock.
   *
   * It is part of the row's identity, so a default of `new Date()` would make every restatement a
   * new instant and the conflict target could never fire — turning "re-running one poll's scoring
   * restates a row" into "appends a duplicate history entry", which is the opposite claim.
   */
  computedAt: Date;
}

/**
 * Record what a scorer made of a signal at a moment.
 *
 * A restatement of the same (signal, version, moment) updates rather than appends — re-running one
 * poll's scoring must not fabricate a second point in the history.
 */
export async function recordScoreSnapshots(
  db: Db,
  orgId: string,
  snapshots: ScoreSnapshotInput[],
): Promise<number> {
  if (snapshots.length === 0) return 0;
  await db
    .insert(riskScoreSnapshots)
    .values(
      snapshots.map((s) => ({
        orgId,
        signalId: s.signalId,
        score: s.score.toString(),
        band: s.band,
        components: s.components,
        reachableMax: s.reachableMax.toString(),
        scorerVersion: s.scorerVersion,
        computedAt: s.computedAt,
      })),
    )
    .onConflictDoUpdate({
      target: [
        riskScoreSnapshots.orgId,
        riskScoreSnapshots.signalId,
        riskScoreSnapshots.scorerVersion,
        riskScoreSnapshots.computedAt,
      ],
      set: {
        score: sql`excluded.score`,
        band: sql`excluded.band`,
        components: sql`excluded.components`,
      },
    });
  return snapshots.length;
}

/** The most recent snapshot for each of the given signals, within this tenant. */
export async function latestScoresForSignals(
  db: Db,
  orgId: string,
  signalIds: string[],
): Promise<Map<string, { score: number; band: string; scorerVersion: string }>> {
  if (signalIds.length === 0) return new Map();
  // DISTINCT ON, not "read the history and keep the first of each in JS": this table is append-only
  // by design, so every score ever recorded for these signals would otherwise cross the wire on
  // every dashboard render and be discarded. Postgres does the same work against
  // `risk_score_snapshots_signal_idx` and returns one row per signal.
  //
  // `id` still breaks the tie: the unique index permits two scorer versions at one instant, so
  // ordering on the timestamp alone would let the planner pick either one.
  const rows = await db
    .selectDistinctOn([riskScoreSnapshots.signalId])
    .from(riskScoreSnapshots)
    .where(
      and(eq(riskScoreSnapshots.orgId, orgId), inArray(riskScoreSnapshots.signalId, signalIds)),
    )
    .orderBy(
      riskScoreSnapshots.signalId,
      desc(riskScoreSnapshots.computedAt),
      desc(riskScoreSnapshots.id),
    );
  const out = new Map<string, { score: number; band: string; scorerVersion: string }>();
  for (const row of rows) {
    out.set(row.signalId, {
      score: Number(row.score),
      band: row.band,
      scorerVersion: row.scorerVersion,
    });
  }
  return out;
}

export interface EvidenceInput {
  signalId: string;
  /** `provider_record` | `evidence_link`. */
  type: string;
  source: string;
  sourceId: string;
  /** The global feed record behind it, where one exists — the recall feeds have none. */
  feedRecordId?: string;
  originUrl: string;
  /** SHA-256 of the payload as seen. NEVER the payload. */
  contentHash: string;
  capturedAt: Date;
}

/**
 * Record the evidence behind this tenant's signals (ticket 09).
 *
 * Re-capturing an UNCHANGED record restates its row rather than appending: the trail answers "what
 * did we see, and when did we first see it", and a poll running hourly would otherwise add an
 * identical artifact every hour forever. `capturedAt` therefore keeps its FIRST value — the answer
 * to "when was this claim first evidenced" is the interesting one, and the signal row already
 * carries `lastFetchedAt` for the other question.
 */
export async function recordEvidence(
  db: Db,
  orgId: string,
  entries: EvidenceInput[],
): Promise<number> {
  if (entries.length === 0) return 0;
  await db
    .insert(signalEvidence)
    .values(entries.map((e) => ({ orgId, ...e })))
    .onConflictDoUpdate({
      target: [
        signalEvidence.orgId,
        signalEvidence.signalId,
        signalEvidence.type,
        signalEvidence.contentHash,
      ],
      // Only the pointer may move — a record that has been re-published at a new URL is the same
      // evidence. `captured_at` is deliberately absent: see the doc block.
      set: { originUrl: sql`excluded.origin_url`, feedRecordId: sql`excluded.feed_record_id` },
    });
  return entries.length;
}

/** The evidence behind one signal, newest capture first. Org-scoped both ways. */
export async function listEvidenceForSignal(
  db: Db,
  orgId: string,
  signalId: string,
): Promise<SignalEvidenceRow[]> {
  return db
    .select()
    .from(signalEvidence)
    .where(and(eq(signalEvidence.orgId, orgId), eq(signalEvidence.signalId, signalId)))
    .orderBy(desc(signalEvidence.capturedAt));
}
