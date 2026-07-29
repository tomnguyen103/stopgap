import {
  matchSignalToItems,
  normalizeCode,
  normalizeName,
  type MatchCandidate,
  type SignalMatch,
  type SignalMatchHints,
} from "@stopgap/catalog";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  inventorySnapshots,
  itemIdentifiers,
  itemSuppliers,
  items,
  procurementEvents,
} from "./schema.js";

/**
 * Signal-to-catalog matching, and the exposure it unlocks (ticket 16).
 *
 * The database's half of the job: fetch the candidate rows and the raw facts. WHICH candidate a
 * signal is about is decided by `matchSignalToItems`, and what the facts MEAN is decided by
 * `summarizeExposure` below — both pure, both testable without Postgres.
 *
 * BATCHED ACROSS SIGNALS ON PURPOSE. A poll writes tens of signals per tenant, and a per-signal
 * round trip would be an N+1 inside the same transaction that holds the signal writes: a long
 * transaction on a pooled connection, for work that is one query either way.
 *
 * Org-scoped `Db` AND an explicit `orgId` predicate on every query, like every other helper here.
 */

/**
 * Trailing window over which procurement is read as consumption.
 *
 * Ninety days rather than thirty: hospital ordering is lumpy — a quarterly buy of a slow-moving
 * item is one order, and a thirty-day window straddling it reports either a burn rate several
 * times the truth or none at all.
 */
export const BURN_WINDOW_DAYS = 90;

/** Normalize the STORED side exactly as `normalizeCode` does, so the query cannot be the stricter one. */
const normalizedIdentifier = sql`regexp_replace(lower(${itemIdentifiers.value}), '[^0-9a-z]', '', 'g')`;
/** Ditto for `normalizeName`: trim, collapse runs of whitespace, lowercase. */
const normalizedItemName = sql`btrim(regexp_replace(lower(${items.name}), '\\s+', ' ', 'g'))`;
const normalizedGenericName = sql`btrim(regexp_replace(lower(coalesce(${items.genericName}, '')), '\\s+', ' ', 'g'))`;

/**
 * Every candidate item for a whole batch of signals, fetched once.
 *
 * A SUPERSET the pure matcher then judges per signal — but a superset that normalizes both sides
 * the same way, so it cannot drop a row the matcher would have accepted. That failure has no
 * symptom: no error, just a shortage that never matched the item on the shelf.
 */
async function candidatesFor(
  db: Db,
  orgId: string,
  hintsList: SignalMatchHints[],
): Promise<MatchCandidate[]> {
  const codes = [
    ...new Set(hintsList.flatMap((h) => [...h.ndcs, ...h.rxcuis]).map(normalizeCode).filter(Boolean)),
  ];
  const names = [...new Set(hintsList.flatMap((h) => h.names).map(normalizeName).filter(Boolean))];
  if (codes.length === 0 && names.length === 0) return [];

  const [byCode, byName] = await Promise.all([
    codes.length > 0
      ? db
          .select({ itemId: itemIdentifiers.itemId })
          .from(itemIdentifiers)
          .where(and(eq(itemIdentifiers.orgId, orgId), inArray(normalizedIdentifier, codes)))
      : Promise.resolve([] as { itemId: string }[]),
    names.length > 0
      ? db
          .select({ itemId: items.id })
          .from(items)
          .where(
            and(
              eq(items.orgId, orgId),
              sql`(${normalizedItemName} = any(${names}) or ${normalizedGenericName} = any(${names}))`,
            ),
          )
      : Promise.resolve([] as { itemId: string }[]),
  ]);

  const itemIds = [...new Set([...byCode, ...byName].map((r) => r.itemId))];
  if (itemIds.length === 0) return [];

  const [rows, identifierRows] = await Promise.all([
    db
      .select({ itemId: items.id, name: items.name, genericName: items.genericName })
      .from(items)
      .where(and(eq(items.orgId, orgId), inArray(items.id, itemIds))),
    db
      .select({
        itemId: itemIdentifiers.itemId,
        type: itemIdentifiers.type,
        value: itemIdentifiers.value,
      })
      .from(itemIdentifiers)
      .where(and(eq(itemIdentifiers.orgId, orgId), inArray(itemIdentifiers.itemId, itemIds))),
  ]);

  const byItem = new Map<string, { type: string; value: string }[]>();
  for (const row of identifierRows) {
    const list = byItem.get(row.itemId) ?? [];
    list.push({ type: row.type, value: row.value });
    byItem.set(row.itemId, list);
  }

  return rows.map((row) => ({
    itemId: row.itemId,
    name: row.name,
    genericName: row.genericName,
    identifiers: byItem.get(row.itemId) ?? [],
  }));
}

/** Which items this tenant's catalog holds for each signal, in the order the signals were given. */
export async function matchSignalsToCatalog(
  db: Db,
  orgId: string,
  hintsList: SignalMatchHints[],
): Promise<SignalMatch[][]> {
  const candidates = await candidatesFor(db, orgId, hintsList);
  return hintsList.map((hints) => matchSignalToItems(hints, candidates));
}

/** One signal's worth of the same thing. */
export async function matchSignalToCatalog(
  db: Db,
  orgId: string,
  hints: SignalMatchHints,
): Promise<SignalMatch[]> {
  return (await matchSignalsToCatalog(db, orgId, [hints]))[0] ?? [];
}

/** The raw catalog rows an exposure reading is computed from. Fetched once per poll, per tenant. */
export interface ExposureFacts {
  stock: { itemId: string; facilityId: string; onHand: number; capturedAt: Date }[];
  burn: { itemId: string; quantity: number }[];
  links: { itemId: string; siteId: string | null; supplierId: string }[];
}

export interface CatalogExposureReading {
  /** Days of stock remaining at the trailing burn rate. Absent when it cannot be computed. */
  daysOnHand?: number;
  /** Supplier sites behind the WORST-supplied matched item. Absent when no link is recorded. */
  supplierSiteCount?: number;
  /** Matched items sourced from exactly one supplier site — the sole-source list. */
  soleSourcedItemIds: string[];
}

/**
 * Turn raw catalog rows into the two figures the scorer consumes. PURE.
 *
 * PER ITEM, THEN WORST-CASE — not summed. Two mistakes are avoided by doing it this way:
 *
 *  - `daysOnHand` divides a stock count by a burn rate, and both are in the item's own unit. Adding
 *    vials to cases before dividing produces a number in no unit at all. Each item's days are
 *    computed separately and the MINIMUM is reported, because a facility about to run out of one
 *    matched presentation is exposed however well stocked the others are.
 *  - `supplierSiteCount` is likewise the minimum across matched items, not the union. Five items
 *    each sole-sourced from a different depot is five distinct sites and five separate single
 *    points of failure; reporting "5" would score it as comfortably supplied — diluting sole-source
 *    risk exactly when it is worst.
 *
 * ABSENT, NOT ZERO, whenever the data does not support an answer. `daysOnHand` needs both a stock
 * count and a burn rate; with no purchasing history there is no burn, and "0 days" for an item
 * nobody orders would tell a pharmacist the facility is about to run out of something it never uses.
 */
export function summarizeExposure(facts: ExposureFacts, itemIds: string[]): CatalogExposureReading {
  const wanted = new Set(itemIds);

  // The LATEST snapshot per (facility, item): an older count is not evidence about today, and
  // summing the history would report every count ever taken as stock on the shelf.
  const latest = new Map<string, { onHand: number; capturedAt: Date }>();
  for (const row of facts.stock) {
    if (!wanted.has(row.itemId)) continue;
    const key = `${row.facilityId}:${row.itemId}`;
    const seen = latest.get(key);
    if (!seen || row.capturedAt > seen.capturedAt) {
      latest.set(key, { onHand: row.onHand, capturedAt: row.capturedAt });
    }
  }
  // Across facilities the unit IS the same — it is one item — so summing is meaningful here.
  const onHandByItem = new Map<string, number>();
  for (const [key, row] of latest) {
    const itemId = key.slice(key.indexOf(":") + 1);
    onHandByItem.set(itemId, (onHandByItem.get(itemId) ?? 0) + row.onHand);
  }

  const orderedByItem = new Map<string, number>();
  for (const row of facts.burn) {
    if (!wanted.has(row.itemId)) continue;
    orderedByItem.set(row.itemId, (orderedByItem.get(row.itemId) ?? 0) + row.quantity);
  }

  let worstDays: number | undefined;
  for (const [itemId, onHand] of onHandByItem) {
    const dailyBurn = (orderedByItem.get(itemId) ?? 0) / BURN_WINDOW_DAYS;
    if (dailyBurn <= 0) continue;
    const days = Math.round((onHand / dailyBurn) * 100) / 100;
    if (worstDays === undefined || days < worstDays) worstDays = days;
  }

  // A link with no site named is still one source of supply — the file did not say WHICH depot,
  // not that there is no supplier.
  const sitesPerItem = new Map<string, Set<string>>();
  for (const row of facts.links) {
    if (!wanted.has(row.itemId)) continue;
    const set = sitesPerItem.get(row.itemId) ?? new Set<string>();
    set.add(row.siteId ?? `supplier:${row.supplierId}`);
    sitesPerItem.set(row.itemId, set);
  }
  let worstSites: number | undefined;
  for (const set of sitesPerItem.values()) {
    if (worstSites === undefined || set.size < worstSites) worstSites = set.size;
  }

  return {
    daysOnHand: worstDays,
    supplierSiteCount: worstSites,
    soleSourcedItemIds: [...sitesPerItem.entries()]
      .filter(([, set]) => set.size === 1)
      .map(([itemId]) => itemId)
      .sort(),
  };
}

/** Fetch every catalog fact these items could contribute, in three queries. */
export async function exposureFacts(
  db: Db,
  orgId: string,
  itemIds: string[],
  now: Date,
): Promise<ExposureFacts> {
  if (itemIds.length === 0) return { stock: [], burn: [], links: [] };
  const since = new Date(now.getTime() - BURN_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [stock, burn, links] = await Promise.all([
    db
      .select({
        itemId: inventorySnapshots.itemId,
        facilityId: inventorySnapshots.facilityId,
        onHand: inventorySnapshots.onHand,
        capturedAt: inventorySnapshots.capturedAt,
      })
      .from(inventorySnapshots)
      .where(and(eq(inventorySnapshots.orgId, orgId), inArray(inventorySnapshots.itemId, itemIds))),
    db
      .select({ itemId: procurementEvents.itemId, quantity: procurementEvents.quantity })
      .from(procurementEvents)
      .where(
        and(
          eq(procurementEvents.orgId, orgId),
          inArray(procurementEvents.itemId, itemIds),
          gte(procurementEvents.orderedAt, since),
        ),
      ),
    db
      .select({
        itemId: itemSuppliers.itemId,
        siteId: itemSuppliers.siteId,
        supplierId: itemSuppliers.supplierId,
      })
      .from(itemSuppliers)
      .where(and(eq(itemSuppliers.orgId, orgId), inArray(itemSuppliers.itemId, itemIds))),
  ]);

  return {
    stock: stock.map((r) => ({ ...r, onHand: Number(r.onHand) })),
    burn: burn.map((r) => ({ ...r, quantity: Number(r.quantity) })),
    links,
  };
}

/** Fetch and summarize in one call, for a caller with a single set of items. */
export async function catalogExposure(
  db: Db,
  orgId: string,
  itemIds: string[],
  now: Date,
): Promise<CatalogExposureReading> {
  return summarizeExposure(await exposureFacts(db, orgId, itemIds, now), itemIds);
}
