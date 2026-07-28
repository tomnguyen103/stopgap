import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { NormalizedSignal } from "@stopgap/ingest";
import { riskScoreSnapshots, riskSignals, type RiskSignalRow } from "./schema.js";
import type { Db } from "./client.js";

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
  signals: NormalizedSignal[],
): Promise<number> {
  if (signals.length === 0) return 0;
  for (const signal of signals) {
    if (signal.dedupeKey.split(":")[0] !== orgId) {
      // A signal normalized for another tenant must never be written into this one. RLS would
      // refuse it anyway (WITH CHECK on org_id), but failing here names the actual mistake —
      // "you normalized with the wrong context" — instead of surfacing as SQLSTATE 42501.
      throw new Error(`signal ${signal.dedupeKey} was not normalized for org ${orgId}`);
    }
    await db
      .insert(riskSignals)
      .values({
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
      })
      .onConflictDoUpdate({
        target: [riskSignals.orgId, riskSignals.dedupeKey],
        set: {
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
          matchHints: signal.matchHints,
          updatedAt: new Date(),
        },
      });
  }
  return signals.length;
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
  components: Record<string, number>;
  scorerVersion: string;
  computedAt?: Date;
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
  for (const s of snapshots) {
    const computedAt = s.computedAt ?? new Date();
    await db
      .insert(riskScoreSnapshots)
      .values({
        orgId,
        signalId: s.signalId,
        score: s.score.toString(),
        band: s.band,
        components: s.components,
        scorerVersion: s.scorerVersion,
        computedAt,
      })
      .onConflictDoUpdate({
        target: [
          riskScoreSnapshots.orgId,
          riskScoreSnapshots.signalId,
          riskScoreSnapshots.scorerVersion,
          riskScoreSnapshots.computedAt,
        ],
        set: { score: s.score.toString(), band: s.band, components: s.components },
      });
  }
  return snapshots.length;
}

/** The most recent snapshot for each of the given signals, within this tenant. */
export async function latestScoresForSignals(
  db: Db,
  orgId: string,
  signalIds: string[],
): Promise<Map<string, { score: number; band: string; scorerVersion: string }>> {
  if (signalIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(riskScoreSnapshots)
    .where(
      and(eq(riskScoreSnapshots.orgId, orgId), inArray(riskScoreSnapshots.signalId, signalIds)),
    )
    .orderBy(desc(riskScoreSnapshots.computedAt));
  const out = new Map<string, { score: number; band: string; scorerVersion: string }>();
  // Rows arrive newest-first, so the FIRST row seen for a signal is its latest snapshot.
  for (const row of rows) {
    if (!out.has(row.signalId)) {
      out.set(row.signalId, {
        score: Number(row.score),
        band: row.band,
        scorerVersion: row.scorerVersion,
      });
    }
  }
  return out;
}
