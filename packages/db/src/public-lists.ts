import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";

import { items, riskScoreSnapshots, riskSignals } from "./schema.js";
import type { Db } from "./client.js";

/**
 * Paged, filtered, sorted reads of signals, scores and catalog items — the query half of the
 * public API's list endpoints (ticket 19).
 *
 * ONE module rather than a `listXPage` scattered through `signals.ts` and `catalog.ts`, because
 * what these three share is not their subject but their EXPOSURE: each turns caller-supplied
 * `sort`, `dir`, `page` and filter strings into an ORDER BY, an OFFSET and a WHERE. Keeping that
 * translation in one file makes "can a query string reach the SQL" a question with one place to
 * look rather than three.
 *
 * Two rules hold throughout:
 *
 *  1. **Sort keys are resolved through a MAP, never interpolated.** An unknown key falls back to
 *     the resource's default instead of reaching the ORDER BY. The route layer already allow-lists
 *     the same keys; this is the second lock on the same door, because the day a new endpoint
 *     forgets to parse through `api-list-query.ts` is the day interpolation would matter.
 *  2. **The org is a parameter and the filters are bound values.** `withOrgDb` has already set
 *     `app.current_org`, so RLS backs every predicate here rather than merely coexisting with it.
 */

export interface Page<T> {
  rows: T[];
  /** Total matching rows, so a client can page without probing for the end. */
  total: number;
}

export interface PagedListOptions {
  q?: string | null;
  sort?: string;
  dir?: "asc" | "desc";
  limit: number;
  offset: number;
  /** Already-validated filter values, keyed as the list schema declares them. */
  filters?: Record<string, string[]>;
}

/**
 * A search term as a safe `ILIKE` pattern.
 *
 * `%`, `_` and `\` are wildcards inside a LIKE pattern, not literals. Left unescaped, a search for
 * `%` matches every row — free work for anyone who can type a URL, on a term the caller believes
 * is a plain substring. Escaped, it matches a literal percent sign, which is what the user asked
 * for. (This is a WILDCARD concern, not an injection one — the term is a bound parameter either
 * way.)
 */
export function likeTerm(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function direction(dir: PagedListOptions["dir"]): typeof asc {
  return dir === "asc" ? asc : desc;
}

/**
 * Resolve a caller's sort key against a map, falling back to the resource's default column.
 *
 * `Object.hasOwn` rather than a bare index read, because a plain object inherits
 * `constructor`, `toString` and the rest of `Object.prototype`: `?sort=constructor` would
 * otherwise resolve to a FUNCTION instead of undefined, the `??` fallback would never fire, and
 * drizzle would be handed something that is not a column. Exported so the offline gate can assert
 * exactly that, which no route-level test can reach — the parser upstream drops the key first.
 */
export function orderBy(
  columns: Record<string, Parameters<typeof asc>[0]>,
  fallback: Parameters<typeof asc>[0],
  options: PagedListOptions,
): SQL {
  const chosen =
    options.sort !== undefined && Object.hasOwn(columns, options.sort)
      ? columns[options.sort]
      : undefined;
  return direction(options.dir)(chosen ?? fallback);
}

const SIGNAL_SORTS = {
  publishedAt: riskSignals.publishedAt,
  observedAt: riskSignals.observedAt,
  severityScore: riskSignals.severityScore,
  title: riskSignals.title,
} as const;

export interface SignalListRow {
  dedupeKey: string;
  source: string;
  sourceId: string;
  riskDomain: string;
  entityType: string;
  entityIdentifier: string;
  title: string;
  summary: string;
  severity: string;
  severityScore: string;
  confidence: string;
  staleness: string;
  sourceResolved: boolean;
  observedAt: Date;
  publishedAt: Date;
  evidenceUrl: string;
}

const SIGNAL_FIELDS = {
  dedupeKey: riskSignals.dedupeKey,
  source: riskSignals.source,
  sourceId: riskSignals.sourceId,
  riskDomain: riskSignals.riskDomain,
  entityType: riskSignals.entityType,
  entityIdentifier: riskSignals.entityIdentifier,
  title: riskSignals.title,
  summary: riskSignals.summary,
  severity: riskSignals.severity,
  severityScore: riskSignals.severityScore,
  confidence: riskSignals.confidence,
  staleness: riskSignals.staleness,
  sourceResolved: riskSignals.sourceResolved,
  observedAt: riskSignals.observedAt,
  publishedAt: riskSignals.publishedAt,
  evidenceUrl: riskSignals.evidenceUrl,
} as const;

function signalPredicates(orgId: string, options: PagedListOptions): SQL[] {
  const predicates: SQL[] = [eq(riskSignals.orgId, orgId)];
  const domains = options.filters?.riskDomain ?? [];
  if (domains.length > 0) predicates.push(inArray(riskSignals.riskDomain, domains));
  const severities = options.filters?.severity ?? [];
  if (severities.length > 0) predicates.push(inArray(riskSignals.severity, severities));
  if (options.q) {
    const term = likeTerm(options.q);
    // Title and entity identifier: the two fields a caller searching for "cefazolin" or an NDC
    // actually holds. The raw payload is deliberately NOT searched — it is evidence, and matching
    // inside it would return rows whose relevance nothing on the response explains.
    predicates.push(
      or(ilike(riskSignals.title, term), ilike(riskSignals.entityIdentifier, term)) as SQL,
    );
  }
  return predicates;
}

/**
 * This tenant's risk signals, one page of them, plus the total the filters matched.
 *
 * `ForApi`, matching `getSignalForApi` beside it, because the console has its OWN
 * `listSignalsPage` in `signals.js` and the two are genuinely different functions: this one speaks
 * the public API's `limit`/`offset` dialect and returns the narrowed `SignalListRow` a key holder
 * is entitled to, while the console's speaks `page` and returns the whole row. They collided in
 * the package barrel as one name exported from two modules — a duplicate-identifier error that
 * neither ticket could see alone, since one shipped on the catalog branch and the other on the
 * console branch.
 */
export async function listSignalsPageForApi(
  db: Db,
  orgId: string,
  options: PagedListOptions,
): Promise<Page<SignalListRow>> {
  const where = and(...signalPredicates(orgId, options));
  const [rows, [counted]] = await Promise.all([
    db
      .select(SIGNAL_FIELDS)
      .from(riskSignals)
      .where(where)
      // `id` breaks ties so paging is stable: two signals published in the same instant would
      // otherwise be free to swap places between page 1 and page 2 and hide a row entirely.
      .orderBy(orderBy(SIGNAL_SORTS, riskSignals.publishedAt, options), desc(riskSignals.id))
      .limit(options.limit)
      .offset(options.offset),
    db.select({ total: sql<number>`count(*)::int` }).from(riskSignals).where(where),
  ]);
  return { rows, total: counted?.total ?? 0 };
}

/** One signal by its dedupe key, in the public API's field set. */
export async function getSignalForApi(
  db: Db,
  orgId: string,
  dedupeKey: string,
): Promise<SignalListRow | undefined> {
  const [row] = await db
    .select(SIGNAL_FIELDS)
    .from(riskSignals)
    .where(and(eq(riskSignals.orgId, orgId), eq(riskSignals.dedupeKey, dedupeKey)))
    .limit(1);
  return row;
}

export interface ScoreListRow {
  dedupeKey: string;
  title: string;
  riskDomain: string;
  score: string;
  band: string;
  reachableMax: string;
  scorerVersion: string;
  computedAt: Date;
}

/**
 * The LATEST snapshot per signal, as a subquery.
 *
 * `distinct on (signal_id)` with the snapshot history ordered newest-first, so a signal scored a
 * hundred times contributes exactly one row. `id` breaks the tie because the unique index permits
 * two scorer versions at one instant — without it the planner is free to pick either, and the
 * same request would answer differently on different days.
 */
function latestSnapshots(db: Db, orgId: string) {
  return db
    .selectDistinctOn([riskScoreSnapshots.signalId], {
      signalId: riskScoreSnapshots.signalId,
      score: riskScoreSnapshots.score,
      band: riskScoreSnapshots.band,
      reachableMax: riskScoreSnapshots.reachableMax,
      scorerVersion: riskScoreSnapshots.scorerVersion,
      computedAt: riskScoreSnapshots.computedAt,
    })
    .from(riskScoreSnapshots)
    .where(eq(riskScoreSnapshots.orgId, orgId))
    .orderBy(
      riskScoreSnapshots.signalId,
      desc(riskScoreSnapshots.computedAt),
      desc(riskScoreSnapshots.id),
    )
    .as("latest");
}

/**
 * This tenant's current scores, ranked on the SCORER's number.
 *
 * Never on `risk_signals.severity_score`: that column is the ingest heuristic the scorer takes as
 * ONE input, and ranking on it would publish a different order than the console shows for the same
 * data — the programme-wide rule that a score shown anywhere is the deterministic scorer's
 * snapshot.
 */
export async function listScoresPage(
  db: Db,
  orgId: string,
  options: PagedListOptions,
): Promise<Page<ScoreListRow>> {
  const latest = latestSnapshots(db, orgId);
  const predicates: SQL[] = [eq(riskSignals.orgId, orgId)];
  const bands = options.filters?.band ?? [];
  if (bands.length > 0) predicates.push(inArray(latest.band, bands));
  if (options.q) predicates.push(ilike(riskSignals.title, likeTerm(options.q)));
  const where = and(...predicates);

  // The composite join condition carries `org_id` as well as the id (PHASE6 §6.5): a join on the
  // id alone would prove the signal exists, not that it belongs to this tenant.
  const joinOn = and(eq(riskSignals.id, latest.signalId), eq(riskSignals.orgId, orgId));
  const sorts = { score: latest.score, computedAt: latest.computedAt } as const;

  const [rows, [counted]] = await Promise.all([
    db
      .select({
        dedupeKey: riskSignals.dedupeKey,
        title: riskSignals.title,
        riskDomain: riskSignals.riskDomain,
        score: latest.score,
        band: latest.band,
        reachableMax: latest.reachableMax,
        scorerVersion: latest.scorerVersion,
        computedAt: latest.computedAt,
      })
      .from(latest)
      .innerJoin(riskSignals, joinOn)
      .where(where)
      .orderBy(orderBy(sorts, latest.score, options), desc(riskSignals.id))
      .limit(options.limit)
      .offset(options.offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(latest)
      .innerJoin(riskSignals, joinOn)
      .where(where),
  ]);
  return { rows, total: counted?.total ?? 0 };
}

const ITEM_SORTS = {
  sku: items.sku,
  name: items.name,
  updatedAt: items.updatedAt,
} as const;

export interface CatalogItemListRow {
  sku: string;
  name: string;
  genericName: string | null;
  unit: string | null;
  updatedAt: Date;
}

/** This tenant's catalog items, one page of them. */
export async function listCatalogItemsPage(
  db: Db,
  orgId: string,
  options: PagedListOptions,
): Promise<Page<CatalogItemListRow>> {
  const predicates: SQL[] = [eq(items.orgId, orgId)];
  if (options.q) {
    const term = likeTerm(options.q);
    predicates.push(
      or(
        ilike(items.sku, term),
        ilike(items.name, term),
        ilike(items.genericName, term),
      ) as SQL,
    );
  }
  const where = and(...predicates);
  const [rows, [counted]] = await Promise.all([
    db
      .select({
        sku: items.sku,
        name: items.name,
        genericName: items.genericName,
        unit: items.unit,
        updatedAt: items.updatedAt,
      })
      .from(items)
      .where(where)
      .orderBy(orderBy(ITEM_SORTS, items.sku, options), desc(items.id))
      .limit(options.limit)
      .offset(options.offset),
    db.select({ total: sql<number>`count(*)::int` }).from(items).where(where),
  ]);
  return { rows, total: counted?.total ?? 0 };
}
