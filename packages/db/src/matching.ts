import { matchSignalToItems, type MatchCandidate, type SignalMatch, type SignalMatchHints } from "@stopgap/catalog";
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
 * The database's half of the job: find the candidate rows and read the facts. WHICH candidate the
 * signal is about is decided by `matchSignalToItems`, which is pure and lives in `@stopgap/catalog`.
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

/** Candidate items for a signal, narrowed in SQL before the pure matcher judges them. */
async function candidatesFor(
  db: Db,
  orgId: string,
  hints: SignalMatchHints,
): Promise<MatchCandidate[]> {
  const codes = [...hints.ndcs, ...hints.rxcuis]
    .map((c) => c.replace(/[^0-9a-z]/gi, "").toLowerCase())
    .filter(Boolean);
  const names = hints.names.map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (codes.length === 0 && names.length === 0) return [];

  // TWO NARROWING QUERIES, UNIONED IN JAVASCRIPT, rather than one clever predicate. The result is
  // a SUPERSET the pure matcher then judges — the punctuation and case rules live there, so the
  // SQL only has to be generous enough not to miss a row, not correct enough to decide one.
  const [byCode, byName] = await Promise.all([
    codes.length > 0
      ? db
          .select({ itemId: itemIdentifiers.itemId })
          .from(itemIdentifiers)
          .where(
            and(
              eq(itemIdentifiers.orgId, orgId),
              inArray(
                sql`regexp_replace(lower(${itemIdentifiers.value}), '[^0-9a-z]', '', 'g')`,
                codes,
              ),
            ),
          )
      : Promise.resolve([] as { itemId: string }[]),
    names.length > 0
      ? db
          .select({ itemId: items.id })
          .from(items)
          .where(
            and(
              eq(items.orgId, orgId),
              sql`(lower(${items.name}) = any(${names}) or lower(coalesce(${items.genericName}, '')) = any(${names}))`,
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

/** Which items in this tenant's catalog a signal's hints point at. */
export async function matchSignalToCatalog(
  db: Db,
  orgId: string,
  hints: SignalMatchHints,
): Promise<SignalMatch[]> {
  return matchSignalToItems(hints, await candidatesFor(db, orgId, hints));
}

/** What the catalog says about this facility's exposure on a set of items. */
export interface CatalogExposureReading {
  /** Days of stock remaining at the trailing burn rate. Absent when it cannot be computed. */
  daysOnHand?: number;
  /** Distinct supplier sites across the matched items. Absent when no supplier link exists. */
  supplierSiteCount?: number;
  /** Matched items sourced from exactly one supplier site — the sole-source list. */
  soleSourcedItemIds: string[];
}

/**
 * Read the two dark score components off the catalog.
 *
 * ABSENT, NOT ZERO, whenever the data does not support an answer. `daysOnHand` needs both a stock
 * count and a burn rate; with no procurement history there is no burn, and reporting "0 days" for
 * an item nobody has ordered would tell a pharmacist the facility is about to run out of something
 * it does not use. The scorer distinguishes the two cases and the console renders them
 * differently, so the honest absence has somewhere to land.
 */
export async function catalogExposure(
  db: Db,
  orgId: string,
  itemIds: string[],
  now: Date,
): Promise<CatalogExposureReading> {
  if (itemIds.length === 0) return { soleSourcedItemIds: [] };

  const since = new Date(now.getTime() - BURN_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [stockRows, burnRows, siteRows] = await Promise.all([
    // The LATEST snapshot per (facility, item): an older count is not evidence about today, and
    // summing the history would report every count ever taken as stock on the shelf.
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
      .select({ itemId: itemSuppliers.itemId, siteId: itemSuppliers.siteId, supplierId: itemSuppliers.supplierId })
      .from(itemSuppliers)
      .where(and(eq(itemSuppliers.orgId, orgId), inArray(itemSuppliers.itemId, itemIds))),
  ]);

  const latest = new Map<string, { onHand: number; capturedAt: Date }>();
  for (const row of stockRows) {
    const key = `${row.facilityId}:${row.itemId}`;
    const seen = latest.get(key);
    if (!seen || row.capturedAt > seen.capturedAt) {
      latest.set(key, { onHand: Number(row.onHand), capturedAt: row.capturedAt });
    }
  }
  const onHand = [...latest.values()].reduce((sum, row) => sum + row.onHand, 0);
  const ordered = burnRows.reduce((sum, row) => sum + Number(row.quantity), 0);
  const dailyBurn = ordered / BURN_WINDOW_DAYS;

  // A sole-sourced item is one with exactly one distinct site. A link with no site named is still
  // one source of supply — the file did not say WHICH depot, not that there is no supplier.
  const sitesPerItem = new Map<string, Set<string>>();
  for (const row of siteRows) {
    const set = sitesPerItem.get(row.itemId) ?? new Set<string>();
    set.add(row.siteId ?? `supplier:${row.supplierId}`);
    sitesPerItem.set(row.itemId, set);
  }
  const allSites = new Set<string>();
  for (const set of sitesPerItem.values()) for (const site of set) allSites.add(site);

  return {
    daysOnHand: latest.size > 0 && dailyBurn > 0 ? Math.round((onHand / dailyBurn) * 100) / 100 : undefined,
    supplierSiteCount: allSites.size > 0 ? allSites.size : undefined,
    soleSourcedItemIds: [...sitesPerItem.entries()]
      .filter(([, set]) => set.size === 1)
      .map(([itemId]) => itemId)
      .sort(),
  };
}
