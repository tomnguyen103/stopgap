import { and, asc, desc, eq, sql } from "drizzle-orm";

import {
  inventorySnapshots,
  itemIdentifiers,
  itemSuppliers,
  items,
  riskSignals,
  suppliers,
} from "./schema.js";
import type { CatalogItemRow } from "./schema.js";
import type { Db } from "./client.js";

/**
 * Reading the facility catalog for the administrator's dashboard (ticket 17).
 *
 * Separate from `catalog.ts`, which WRITES an import: the read path is paged, filtered and joined
 * for a page, and mixing it into the import module would give one file two reasons to change.
 * Every query carries an explicit org predicate as well as relying on RLS.
 */

export interface CatalogBrowseOptions {
  q?: string | null;
  /** `sole` or `multi` — how many supplier SITES can deliver the item. */
  sourcing?: string;
  sort: string;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
}

export interface CatalogListItem {
  id: string;
  sku: string;
  name: string;
  genericName: string | null;
  unit: string | null;
  /** Distinct supplier SITES, which is what a shortage has to route around. */
  supplierSiteCount: number;
  /** Most recent on-hand reading, or null when the facility has uploaded no inventory. */
  onHand: number | null;
}

/**
 * One page of the facility's catalog.
 *
 * Counted DISTINCT on the site rather than on the supplier row: two contracts with one supplier at
 * one site is still one place the product comes from, and counting rows would report an item as
 * multi-sourced because somebody uploaded its price twice.
 */
export async function browseCatalog(
  db: Db,
  orgId: string,
  options: CatalogBrowseOptions,
): Promise<{ rows: CatalogListItem[]; total: number; page: number }> {
  // Both bounds, and a finite one: `pageSize: NaN` would otherwise reach LIMIT as NaN.
  const term = options.q?.trim();
  const escaped = term ? term.replace(/([\\%_])/g, "\\$1") : null;
  const like = escaped === null ? null : `%${escaped}%`;
  const sort = ["name", "sku", "suppliers"].includes(options.sort) ? options.sort : "name";
  const pageSize = Number.isFinite(options.pageSize)
    ? Math.max(1, Math.min(Math.floor(options.pageSize), 500))
    : 25;

  const base = sql`
    with sites as (
      -- Distinct SITES: an item supplied from two sites of one supplier has two ways in, and one
      -- supplier with no site recorded is still one way in, so coalescing onto the supplier id
      -- counts that case once rather than dropping it.
      select item_id, count(distinct coalesce(site_id, supplier_id)) as site_count
        from ${itemSuppliers}
       where org_id = ${orgId}
       group by item_id
    ),
    latest_inventory as (
      select distinct on (item_id) item_id, on_hand
        from ${inventorySnapshots}
       where org_id = ${orgId}
       order by item_id, captured_at desc
    ),
    catalog as (
      select i.id, i.sku, i.name, i.generic_name, i.unit,
             coalesce(sites.site_count, 0) as site_count,
             latest_inventory.on_hand
        from ${items} i
        left join sites on sites.item_id = i.id
        left join latest_inventory on latest_inventory.item_id = i.id
       where i.org_id = ${orgId}
         and (${like}::text is null
              or i.name ilike ${like} escape '\\'
              or i.sku ilike ${like} escape '\\'
              or i.generic_name ilike ${like} escape '\\')
         -- EXACTLY one site is sole-sourced; zero is unsourced, which is a hole in the catalog
         -- rather than a fact about the supply chain. The two are separate filters for that
         -- reason, and catalogCoverage counts them the same way.
         and (${options.sourcing ?? null}::text is null
              or (${options.sourcing ?? null} = 'sole' and coalesce(sites.site_count, 0) = 1)
              or (${options.sourcing ?? null} = 'multi' and coalesce(sites.site_count, 0) > 1)
              or (${options.sourcing ?? null} = 'unsourced' and coalesce(sites.site_count, 0) = 0))
    )`;

  // The ORDER BY is assembled from an allow-listed key, never interpolated from the parameter.
  const order =
    sort === "sku" ? sql`sku` : sort === "suppliers" ? sql`site_count` : sql`lower(name)`;

  /**
   * ONE STATEMENT for the page AND the total (batch-A review finding 13).
   *
   * This used to be two `db.execute`s over the same `base` CTE — a `count(*)` and then the page —
   * so every page view built the join, the distinct-on and the ILIKE filter TWICE to return one
   * screen of rows. `count(*) over ()` is the standard way to carry the size of the filtered set out
   * with the page: same result, one pass.
   *
   * The window count comes back repeated on every row and is identical across them, so reading it
   * from the first is not a sample — it is the value.
   */
  const pageAt = (at: number) =>
    db.execute<{
      id: string;
      sku: string;
      name: string;
      generic_name: string | null;
      unit: string | null;
      site_count: string;
      on_hand: string | null;
      total: string;
    }>(sql`
      ${base}
      select *, (count(*) over ())::text as total from catalog
       order by ${order} ${options.dir === "desc" ? sql`desc` : sql`asc`}, sku
       limit ${pageSize} offset ${(at - 1) * pageSize}
    `);

  // Sanitized the same way `pageSize` is, and for the same reason: a hand-edited address must
  // degrade to a sensible default rather than reach OFFSET as NaN.
  const requested = Number.isFinite(options.page) ? Math.max(1, Math.floor(options.page)) : 1;
  let page = requested;
  let rows = await pageAt(page);
  let total = Number(rows[0]?.total ?? 0);

  // AN EMPTY PAGE PAST THE END is the one case the window count cannot answer — no rows means no
  // count either — so it is also the only case that still costs a second statement. A page-1 miss
  // needs none of this: an empty catalog and an empty first page are the same answer.
  if (rows.length === 0 && page > 1) {
    const [counted] = await db.execute<{ total: string }>(
      sql`${base} select count(*)::text as total from catalog`,
    );
    total = Number(counted?.total ?? 0);
    page = Math.max(1, Math.min(page, Math.max(1, Math.ceil(total / pageSize))));
    if (page !== requested) rows = await pageAt(page);
  }

  return {
    total,
    page,
    rows: rows.map((row) => ({
      id: row.id,
      sku: row.sku,
      name: row.name,
      genericName: row.generic_name,
      unit: row.unit,
      supplierSiteCount: Number(row.site_count),
      onHand: row.on_hand === null ? null : Number(row.on_hand),
    })),
  };
}

/** One catalog item with everything the detail view shows. */
export interface CatalogItemDetail {
  item: CatalogItemRow;
  /**
   * Distinct supplier sites, counted by the SAME expression the list uses.
   *
   * Recomputed in the page from supplier names, the detail view could badge an item sole-sourced
   * while the list badged it multi — two same-named suppliers are one name and two ids.
   */
  supplierSiteCount: number;
  identifiers: { kind: string; value: string }[];
  suppliers: { name: string; code: string | null; preferred: boolean; site: string | null }[];
  inventory: { onHand: number; unit: string | null; capturedAt: Date }[];
  /** Signals whose match hints name this item — the reason it is on a risk list. */
  signals: { dedupeKey: string; title: string; riskDomain: string; severity: string }[];
}

export async function getCatalogItem(
  db: Db,
  orgId: string,
  sku: string,
): Promise<CatalogItemDetail | undefined> {
  const [item] = await db
    .select()
    .from(items)
    .where(and(eq(items.orgId, orgId), eq(items.sku, sku)))
    .limit(1);
  if (!item) return undefined;

  const identifiers = await db
    .select({ kind: itemIdentifiers.type, value: itemIdentifiers.value })
    .from(itemIdentifiers)
    .where(and(eq(itemIdentifiers.orgId, orgId), eq(itemIdentifiers.itemId, item.id)))
    .orderBy(asc(itemIdentifiers.type), asc(itemIdentifiers.value));

  const supplierRows = await db
    .select({
      name: suppliers.name,
      code: suppliers.code,
      preferred: itemSuppliers.preferred,
      siteId: itemSuppliers.siteId,
      supplierId: itemSuppliers.supplierId,
    })
    .from(itemSuppliers)
    .innerJoin(
      suppliers,
      and(eq(suppliers.orgId, orgId), eq(suppliers.id, itemSuppliers.supplierId)),
    )
    .where(and(eq(itemSuppliers.orgId, orgId), eq(itemSuppliers.itemId, item.id)))
    .orderBy(desc(itemSuppliers.preferred), asc(suppliers.name));

  const inventory = await db
    .select({
      onHand: inventorySnapshots.onHand,
      unit: inventorySnapshots.unit,
      capturedAt: inventorySnapshots.capturedAt,
    })
    .from(inventorySnapshots)
    .where(and(eq(inventorySnapshots.orgId, orgId), eq(inventorySnapshots.itemId, item.id)))
    .orderBy(desc(inventorySnapshots.capturedAt))
    .limit(10);

  // Matched by the identifiers the item actually carries, and by its names — the same hints the
  // poll's matcher reads, run the other way round.
  //
  // The candidate lists are expanded into the statement as individual bound parameters rather than
  // one array parameter: a JS array handed to `= any(...)` binds as a record, which Postgres
  // refuses to cast to `text[]`. Each value is still a parameter, never interpolated text.
  const identifierValues = identifiers.map((row) => row.value.toLowerCase());
  const names = [item.name, item.genericName]
    .filter((n): n is string => n !== null)
    .map((n) => n.toLowerCase());
  const idList =
    identifierValues.length === 0
      ? null
      : sql.join(
          identifierValues.map((value) => sql`${value}`),
          sql`, `,
        );
  const nameList =
    names.length === 0
      ? null
      : sql.join(
          names.map((value) => sql`${value}`),
          sql`, `,
        );
  const predicates = [
    idList === null
      ? null
      : sql`exists (
            select 1 from jsonb_array_elements_text(s.match_hints -> 'ndcs') as ndc
             where lower(ndc) in (${idList})
          )`,
    idList === null
      ? null
      : sql`exists (
            select 1 from jsonb_array_elements_text(s.match_hints -> 'rxcuis') as rxcui
             where lower(rxcui) in (${idList})
          )`,
    nameList === null ? null : sql`lower(s.entity_identifier) in (${nameList})`,
  ].filter((p): p is NonNullable<typeof p> => p !== null);

  // Nothing to match on is not "match everything": an item with no identifiers and no name would
  // otherwise pull the tenant's whole signal list onto its page.
  const signals =
    predicates.length === 0
      ? []
      : await db.execute<{
          dedupe_key: string;
          title: string;
          risk_domain: string;
          severity: string;
        }>(sql`
          select s.dedupe_key, s.title, s.risk_domain, s.severity
            from ${riskSignals} s
           where s.org_id = ${orgId}
             and (${sql.join(predicates, sql` or `)})
           order by s.published_at desc
           limit 25
        `);

  return {
    item,
    supplierSiteCount: new Set(supplierRows.map((row) => row.siteId ?? row.supplierId)).size,
    identifiers,
    suppliers: supplierRows.map((row) => ({
      name: row.name,
      code: row.code,
      preferred: row.preferred,
      site: row.siteId,
    })),
    inventory: inventory.map((row) => ({
      onHand: Number(row.onHand),
      unit: row.unit,
      capturedAt: row.capturedAt,
    })),
    signals: signals.map((row) => ({
      dedupeKey: row.dedupe_key,
      title: row.title,
      riskDomain: row.risk_domain,
      severity: row.severity,
    })),
  };
}

/** How much of the catalog exists — the setup checklist's evidence. */
export interface CatalogCoverage {
  items: number;
  suppliers: number;
  itemsWithSupplier: number;
  itemsWithInventory: number;
  soleSourced: number;
}

export async function catalogCoverage(db: Db, orgId: string): Promise<CatalogCoverage> {
  const [row] = await db.execute<{
    items: string;
    suppliers: string;
    items_with_supplier: string;
    items_with_inventory: string;
    sole_sourced: string;
  }>(sql`
    with sites as (
      select item_id, count(distinct coalesce(site_id, supplier_id)) as site_count
        from ${itemSuppliers} where org_id = ${orgId} group by item_id
    )
    select (select count(*) from ${items} where org_id = ${orgId})::text as items,
           (select count(*) from ${suppliers} where org_id = ${orgId})::text as suppliers,
           (select count(*) from sites)::text as items_with_supplier,
           (select count(distinct item_id) from ${inventorySnapshots}
             where org_id = ${orgId})::text as items_with_inventory,
           -- Exactly one, matching the list's own filter. Counting one-or-fewer here while the
           -- filter counted exactly one made the checklist disagree with the list it links to.
           (select count(*) from sites where site_count = 1)::text as sole_sourced
  `);
  return {
    items: Number(row?.items ?? 0),
    suppliers: Number(row?.suppliers ?? 0),
    itemsWithSupplier: Number(row?.items_with_supplier ?? 0),
    itemsWithInventory: Number(row?.items_with_inventory ?? 0),
    soleSourced: Number(row?.sole_sourced ?? 0),
  };
}
