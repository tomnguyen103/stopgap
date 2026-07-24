import { desc, sql } from "drizzle-orm";
import type { ShortageRecord } from "@stopgap/core";
import type { Db } from "./client.js";
import { feedRecords } from "./schema.js";

/**
 * Feed freshness for the console's live-feed panel (PROJECT_PLAN §11: "live-feed panel with
 * last-polled timestamp").
 *
 * The timestamp comes from the newest stored feed record per source rather than from a
 * "last poll succeeded" flag: a flag says a poll ran, this says data actually arrived. A
 * source that has never returned anything is absent from the result, which is the honest
 * rendering of "ASHP is stubbed without a key".
 */

/**
 * Store what a poll returned, one row per feed record. `(source, sourceId)` is unique, so a
 * re-poll updates the existing row: the table is a current-state mirror with provenance, not
 * an event log, and the fetch timestamp is what makes "last polled" answerable.
 */
export async function recordFeedRecords(
  db: Db,
  records: readonly ShortageRecord[],
  contentHashOf: (record: ShortageRecord) => string,
  fetchedAt: Date = new Date(),
): Promise<number> {
  if (records.length === 0) return 0;
  const rows = records.map((r) => ({
    source: r.source,
    sourceId: r.sourceId,
    key: r.key,
    status: r.status,
    payload: { genericName: r.genericName, ndcs: r.ndcs, note: r.note ?? null } as Record<
      string,
      unknown
    >,
    contentHash: contentHashOf(r),
    fetchedAt,
  }));
  await db
    .insert(feedRecords)
    .values(rows)
    .onConflictDoUpdate({
      target: [feedRecords.source, feedRecords.sourceId],
      set: {
        key: sql`excluded.key`,
        status: sql`excluded.status`,
        payload: sql`excluded.payload`,
        contentHash: sql`excluded.content_hash`,
        fetchedAt: sql`excluded.fetched_at`,
      },
    });
  return rows.length;
}

export interface FeedFreshness {
  source: string;
  lastFetchedAt: Date;
  records: number;
}

export async function feedFreshness(db: Db): Promise<FeedFreshness[]> {
  const rows = await db
    .select({
      source: feedRecords.source,
      lastFetchedAt: sql<Date>`max(${feedRecords.fetchedAt})`,
      records: sql<number>`count(*)::int`,
    })
    .from(feedRecords)
    .groupBy(feedRecords.source)
    .orderBy(desc(sql`max(${feedRecords.fetchedAt})`));
  return rows.map((r) => ({ ...r, lastFetchedAt: new Date(r.lastFetchedAt) }));
}
