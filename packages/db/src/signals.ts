import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";

import {
  cases,
  riskScoreSnapshots,
  riskSignals,
  signalEvidence,
  type RiskSignalRow,
  type SignalEvidenceRow,
} from "./schema.js";
import type { Db } from "./client.js";

/**
 * The page number an OFFSET can safely be built from.
 *
 * FLOOR, CEILING, AND SHAPE. The console's own parser (`list-params.ts`) already guarantees a
 * positive safe integer, but every paginator here is exported from `@stopgap/db`, and a caller that
 * is not that parser is the whole reason this exists: a zero or negative page reaches OFFSET
 * negative, a fractional one reaches `OFFSET 12.5`, and `NaN` reaches `OFFSET NaN` — all three are
 * errors from Postgres rather than an empty page. A page past the end clamps to the last one, which
 * is what stops `?page=500` on a three-page list rendering an empty table headed "Page 500 of 3".
 *
 * Shared by `listSignalsPage` and `listCaseQueue`, which had the same clamp written out twice.
 */
export function clampPage(page: number, total: number, pageSize: number): number {
  // PAGE SIZE FIRST, and by throwing rather than clamping. A bad `page` has an obvious right
  // answer — the nearest real page — but a `pageSize` of 0, -10 or NaN has none: it reaches
  // `LIMIT` directly, where zero silently returns an empty page and the other two are errors from
  // Postgres. Clamping it to an invented default would answer a question the caller did not ask.
  // The console's parser allow-lists the sizes it offers, so anything else is a programming error
  // in a caller, which is what this says.
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new RangeError(`pageSize must be a positive safe integer, got ${String(pageSize)}`);
  }
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  // NaN is the one value the min/max sandwich cannot rescue — it propagates through both and reaches
  // OFFSET intact. An infinity needs no special case: it clamps to the last page like any overshoot.
  if (Number.isNaN(page)) return 1;
  return Math.max(1, Math.min(Math.trunc(page), lastPage));
}

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

/** What a console list asks for. Every field is already parsed and bounded by `list-params`. */
export interface SignalPageOptions {
  /** Free text over the signal's title and the entity it names. Already length-bounded. */
  q?: string | null;
  riskDomain?: string;
  severity?: string;
  /** The contract's own staleness label — `fresh` | `aging` | `stale`. */
  freshness?: string;
  sort: string;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
}

/**
 * Sort keys a caller may name, mapped to the column each one means.
 *
 * Resolved with `Object.hasOwn`, never `SIGNAL_SORT_COLUMNS[key]`: a bare index read answers
 * `?sort=constructor` with a function, which is truthy, so the `??` fallback beside it never fires
 * and the value reaches the ORDER BY.
 */
const SIGNAL_SORT_COLUMNS = {
  published: riskSignals.publishedAt,
  fetched: riskSignals.lastFetchedAt,
  severity: riskSignals.severityScore,
  entity: riskSignals.entityIdentifier,
} as const;

export const SIGNAL_SORT_KEYS = Object.keys(SIGNAL_SORT_COLUMNS);

/**
 * One page of this tenant's signals, plus the total the page was taken from.
 *
 * The count runs as its own statement rather than a window function beside the rows: the window
 * form computes the total for every row it returns and is the shape that makes a paged list slow
 * exactly when the list is long enough to need paging.
 */
export async function listSignalsPage(
  db: Db,
  orgId: string,
  options: SignalPageOptions,
): Promise<{ rows: RiskSignalRow[]; total: number; page: number }> {
  const predicates = [eq(riskSignals.orgId, orgId)];
  if (options.riskDomain) predicates.push(eq(riskSignals.riskDomain, options.riskDomain));
  if (options.severity) predicates.push(eq(riskSignals.severity, options.severity));
  if (options.freshness) predicates.push(eq(riskSignals.staleness, options.freshness));
  const term = options.q?.trim();
  if (term) {
    // `%` and `_` are LIKE metacharacters: a search for "50%" must find the literal string, not
    // every row. Escaped here rather than stripped, because a drug presentation legitimately
    // contains both.
    const escaped = term.replace(/([\\%_])/g, "\\$1");
    predicates.push(
      sql`(${riskSignals.title} ilike ${"%" + escaped + "%"} escape '\\'
           or ${riskSignals.entityIdentifier} ilike ${"%" + escaped + "%"} escape '\\')`,
    );
  }
  const where = and(...predicates);
  const column = Object.hasOwn(SIGNAL_SORT_COLUMNS, options.sort)
    ? SIGNAL_SORT_COLUMNS[options.sort as keyof typeof SIGNAL_SORT_COLUMNS]
    : riskSignals.publishedAt;
  const [counted] = await db
    .select({ total: sql<string>`count(*)` })
    .from(riskSignals)
    .where(where);
  const total = Number(counted?.total ?? 0);
  // The count comes FIRST so the page can be clamped to it: only the count knows where the rows
  // stop. See `clampPage` for what else it defends against.
  const page = clampPage(options.page, total, options.pageSize);
  const rows = await db
    .select()
    .from(riskSignals)
    .where(where)
    // `id` last, so two signals published in the same instant hold a stable order between pages —
    // without it a row can appear on page 1 and again on page 2.
    .orderBy(options.dir === "asc" ? column : desc(column), desc(riskSignals.id))
    .limit(options.pageSize)
    .offset((page - 1) * options.pageSize);
  return { rows, total, page };
}

/** An open case, with the score of the strongest signal naming the same product. */
export interface RankedCase {
  id: string;
  key: string;
  genericName: string;
  status: string;
  /** The signal whose score this is — where the breakdown behind the rank is readable. */
  signalKey: string | null;
  /** Absent when no signal names this product — shown as unscored, never as zero. */
  score: number | null;
  band: string | null;
  reachableMax: number | null;
  components: Record<string, number> | null;
}

/**
 * This tenant's open cases, ranked by risk score.
 *
 * The linkage is `cases.generic_name` = `risk_signals.entity_identifier`, which is an identity both
 * sides already derive from the same feed record — not the catalog matching ticket 16 builds. It
 * therefore misses a case whose product is named differently by a second feed, and that is the
 * honest limit of what can be joined before catalog identifiers land.
 *
 * A case with no matching signal keeps a NULL score and sorts last. Scoring it zero would rank it
 * beside a product the scorer has genuinely cleared, which is the one reading that is worse than
 * saying "not scored".
 */
export async function rankedOpenCases(
  db: Db,
  orgId: string,
  q: string | null = null,
  limit = 10,
): Promise<RankedCase[]> {
  const term = q?.trim();
  // Same escape as the signals list: `%` and `_` are LIKE metacharacters, and a product name
  // legitimately contains both.
  const escaped = term ? term.replace(/([\\%_])/g, "\\$1") : null;
  const rows = await db.execute<{
    id: string;
    key: string;
    generic_name: string;
    status: string;
    dedupe_key: string | null;
    score: string | null;
    band: string | null;
    reachable_max: string | null;
    components: Record<string, number> | null;
  }>(sql`
    with latest as (
      select distinct on (s.id) s.entity_identifier, s.dedupe_key, snap.score, snap.band,
             snap.reachable_max, snap.components
        from ${riskSignals} s
        join ${riskScoreSnapshots} snap
          on snap.signal_id = s.id and snap.org_id = ${orgId}
       where s.org_id = ${orgId}
       order by s.id, snap.computed_at desc, snap.id desc
    ),
    best as (
      select lower(entity_identifier) as entity, dedupe_key, score, band, reachable_max, components,
             -- Ranked on the FRACTION of what each score could reach, not on raw points: once the
             -- catalog slice lands, a 40-out-of-65 and a 45-out-of-100 sit in the same column, and
             -- comparing the raw numbers would rank the milder hazard first. The dedupe key breaks
             -- the tie so two equal scores do not swap places between renders.
             row_number() over (
               partition by lower(entity_identifier)
               -- NULLS LAST, explicitly. Postgres puts nulls FIRST for a descending sort, so a
               -- signal whose reachable_max is 0 -- no score expressible at all -- outranked every
               -- scored one and became the case's strongest signal. The evidence panel orders the
               -- same fraction with nulls last, so the two disagreed about which signal a case was
               -- ranked on: the contradiction both orderings exist to prevent.
               order by score / nullif(reachable_max, 0) desc nulls last, dedupe_key
             ) as rank
        from latest
    )
    select c.id, c.key, c.generic_name, c.status, best.dedupe_key,
           best.score, best.band, best.reachable_max, best.components
      from ${cases} c
      left join best on best.entity = lower(c.generic_name) and best.rank = 1
     where c.org_id = ${orgId}
       and c.closed_at is null
       and c.status not in ('closed', 'rejected')
       and (${escaped}::text is null
            or c.generic_name ilike ${escaped === null ? null : "%" + escaped + "%"} escape '\\')
     order by best.score / nullif(best.reachable_max, 0) desc nulls last, c.updated_at desc
     limit ${limit}
  `);
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    genericName: row.generic_name,
    status: row.status,
    signalKey: row.dedupe_key,
    score: row.score === null ? null : Number(row.score),
    band: row.band,
    reachableMax: row.reachable_max === null ? null : Number(row.reachable_max),
    components: row.components,
  }));
}

/** A page of the pharmacist's review queue, ranked by risk score (ticket 11). */
export interface CaseQueueOptions {
  q?: string | null;
  status?: string;
  severity?: string;
  riskDomain?: string;
  sort: string;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
}

export interface QueuedCase extends RankedCase {
  /** What the case detail route is keyed on — the id the ROW carries, never one recomputed. */
  workflowId: string;
  severity: string | null;
  riskDomain: string | null;
  updatedAt: Date;
}

/**
 * One page of this tenant's open cases, ranked by risk score, with the filters the queue offers.
 *
 * Shares the scoring join with `rankedOpenCases` — same linkage, same stated limit — but pages,
 * searches and filters rather than returning a fixed top slice. Kept as its own statement instead
 * of a `limit`/`offset` bolted onto the other one: the overview wants the strongest few open cases
 * and nothing else, and a shared function taking eight optional arguments to serve two callers is
 * how a query grows a shape neither of them wants.
 *
 * The RISK DOMAIN filter is a property of the matched signal, not of the case: a case with no
 * signal has no domain, and filtering on one therefore excludes it rather than showing it
 * domain-less. That is the honest reading — "show me recalls" cannot include a case nothing has
 * classified.
 */
export async function listCaseQueue(
  db: Db,
  orgId: string,
  options: CaseQueueOptions,
): Promise<{ rows: QueuedCase[]; total: number; page: number }> {
  const term = options.q?.trim();
  // `%` and `_` are LIKE metacharacters; a product name legitimately contains both.
  const escaped = term ? term.replace(/([\\%_])/g, "\\$1") : null;
  const like = escaped === null ? null : "%" + escaped + "%";
  // Sort keys are an allow-list resolved by equality, never interpolated: this value comes from a
  // query string and reaches an ORDER BY.
  const sort = ["score", "updated", "severity", "entity"].includes(options.sort)
    ? options.sort
    : "score";
  const ascending = options.dir === "asc";

  const scored = sql`
    with latest as (
      select distinct on (s.id) s.entity_identifier, s.dedupe_key, s.risk_domain, s.severity,
             snap.score, snap.band, snap.reachable_max, snap.components
        from ${riskSignals} s
        join ${riskScoreSnapshots} snap
          on snap.signal_id = s.id and snap.org_id = ${orgId}
       where s.org_id = ${orgId}
       order by s.id, snap.computed_at desc, snap.id desc
    ),
    best as (
      select lower(entity_identifier) as entity, dedupe_key, risk_domain, severity, score, band,
             reachable_max, components,
             row_number() over (
               partition by lower(entity_identifier)
               -- NULLS LAST, explicitly. Postgres puts nulls FIRST for a descending sort, so a
               -- signal whose reachable_max is 0 -- no score expressible at all -- outranked every
               -- scored one and became the case's strongest signal. The evidence panel orders the
               -- same fraction with nulls last, so the two disagreed about which signal a case was
               -- ranked on: the contradiction both orderings exist to prevent.
               order by score / nullif(reachable_max, 0) desc nulls last, dedupe_key
             ) as rank
        from latest
    ),
    queue as (
      select c.id, c.key, c.workflow_id, c.generic_name, c.status, c.updated_at,
             best.dedupe_key, best.risk_domain, best.severity, best.score, best.band,
             best.reachable_max, best.components
        from ${cases} c
        left join best on best.entity = lower(c.generic_name) and best.rank = 1
       where c.org_id = ${orgId}
         and c.closed_at is null
         and c.status not in ('closed', 'rejected')
         and (${options.status ?? null}::text is null or c.status = ${options.status ?? null})
         and (${options.severity ?? null}::text is null or best.severity = ${options.severity ?? null})
         and (${options.riskDomain ?? null}::text is null or best.risk_domain = ${options.riskDomain ?? null})
         and (${like}::text is null or c.generic_name ilike ${like} escape '\\')
    )`;

  const [counted] = await db.execute<{ total: string }>(
    sql`${scored} select count(*)::text as total from queue`,
  );
  const total = Number(counted?.total ?? 0);
  const page = clampPage(options.page, total, options.pageSize);

  // ORDER BY assembled from the allow-listed key, never from the raw parameter. `id` last, so two
  // cases with equal scores hold their order between pages instead of swapping.
  const order =
    sort === "updated"
      ? sql`updated_at`
      : sort === "severity"
        ? // The RANK, not the text. `severity` holds low | moderate | high | critical, so ordering
          // the column alphabetically puts moderate above high and critical last — a severity sort
          // that buries the worst case is worse than no severity sort.
          sql`case severity
                when 'critical' then 4
                when 'high' then 3
                when 'moderate' then 2
                when 'low' then 1
                else 0
              end`
        : sort === "entity"
          ? sql`lower(generic_name)`
          : sql`score / nullif(reachable_max, 0)`;
  const rows = await db.execute<{
    id: string;
    key: string;
    workflow_id: string;
    generic_name: string;
    status: string;
    updated_at: string;
    dedupe_key: string | null;
    risk_domain: string | null;
    severity: string | null;
    score: string | null;
    band: string | null;
    reachable_max: string | null;
    components: Record<string, number> | null;
  }>(sql`
    ${scored}
    select * from queue
     order by ${order} ${ascending ? sql`asc nulls last` : sql`desc nulls last`}, id
     limit ${options.pageSize} offset ${(page - 1) * options.pageSize}
  `);

  return {
    total,
    page,
    rows: rows.map((row) => ({
      id: row.id,
      key: row.key,
      workflowId: row.workflow_id,
      genericName: row.generic_name,
      status: row.status,
      updatedAt: new Date(row.updated_at),
      signalKey: row.dedupe_key,
      riskDomain: row.risk_domain,
      severity: row.severity,
      score: row.score === null ? null : Number(row.score),
      band: row.band,
      reachableMax: row.reachable_max === null ? null : Number(row.reachable_max),
      components: row.components,
    })),
  };
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

/**
 * What an artifact points at.
 *
 * A closed vocabulary because `type` is part of the trail's unique key: a typo would not mislabel
 * a row, it would fork one capture into two artifacts.
 */
export const EVIDENCE_TYPES = ["provider_record", "evidence_link"] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export interface EvidenceInput {
  signalId: string;
  type: EvidenceType;
  source: string;
  sourceId: string;
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
      // Only the pointer may move — a record re-published at a new URL is the same evidence.
      // `captured_at` is deliberately absent: see the doc block.
      set: { originUrl: sql`excluded.origin_url` },
    });
  return entries.length;
}

/**
 * The evidence behind one signal, newest capture first. Org-scoped both ways.
 *
 * Bounded, like `listSignals`: a signal whose provider record churns daily accumulates a row per
 * change, and an unbounded read of a years-long trail is a page that stops loading rather than a
 * page that shows everything.
 */
export async function listEvidenceForSignal(
  db: Db,
  orgId: string,
  signalId: string,
  limit = 200,
): Promise<SignalEvidenceRow[]> {
  return db
    .select()
    .from(signalEvidence)
    .where(and(eq(signalEvidence.orgId, orgId), eq(signalEvidence.signalId, signalId)))
    .orderBy(desc(signalEvidence.capturedAt))
    .limit(limit);
}
