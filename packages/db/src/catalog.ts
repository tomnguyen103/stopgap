import { and, eq, inArray, or } from "drizzle-orm";
import {
  itemIdentifiers as identifiersOf,
  type CatalogKind,
  type ImportPlan,
} from "@stopgap/catalog";
import { withOrgDb } from "./org-context.js";
import {
  facilities,
  itemIdentifiers,
  itemSuppliers,
  items,
  inventorySnapshots,
  procurementEvents,
  supplierSites,
  suppliers,
} from "./schema.js";

/**
 * Writing a catalog import.
 *
 * The whole of the decision — what the file says, and what is wrong with it — was made by
 * `planImport` in `@stopgap/catalog`, with no database involved. This module does the other half
 * and nothing else: take a CLEAN plan and apply it inside one transaction.
 *
 * Two rules make "a failed import leaves no partial data" a property rather than a hope:
 *
 *  1. A plan carrying ANY error is refused before a single statement runs. Half-importing the good
 *     rows of a bad file is the worst outcome available — the administrator fixes the file,
 *     re-uploads, and now cannot tell which rows came from which attempt.
 *  2. Everything runs inside `withOrgDb`, which is already a transaction. A failure at row 3,900
 *     of 4,000 rolls the first 3,899 back with it.
 *
 * Re-uploading a corrected file UPDATES rather than duplicates. Items are matched on their
 * IDENTIFIERS, not on the sku alone (ticket 15: "keyed on item identifiers"), so a corrected file
 * that fixes a mistyped sku while keeping the NDC updates the item it already had instead of
 * creating a second one and orphaning the first.
 */

/** What an import did. Rows APPLIED, which for an upsert is every row of a clean plan. */
export interface ImportResult {
  kind: CatalogKind;
  rowsApplied: number;
}

/** A plan with errors in it, refused before anything was written. */
export class RefusedImportError extends Error {
  constructor(readonly errors: ImportPlan<CatalogKind>["errors"]) {
    super(`import refused: ${errors.length} invalid row(s)`);
    this.name = "RefusedImportError";
  }
}

export async function importCatalog<K extends CatalogKind>(
  orgId: string,
  plan: ImportPlan<K>,
): Promise<ImportResult> {
  if (!plan.ok) throw new RefusedImportError(plan.errors);
  return withOrgDb(orgId, async (db) => {
    switch (plan.kind) {
      case "items":
        await writeItems(db, orgId, plan as ImportPlan<"items">);
        break;
      case "suppliers":
        await writeSuppliers(db, orgId, plan as ImportPlan<"suppliers">);
        break;
      case "item_suppliers":
        await writeItemSuppliers(db, orgId, plan as ImportPlan<"item_suppliers">);
        break;
      case "inventory":
        await writeInventory(db, orgId, plan as ImportPlan<"inventory">);
        break;
      case "procurement":
        await writeProcurement(db, orgId, plan as ImportPlan<"procurement">);
        break;
    }
    return { kind: plan.kind, rowsApplied: plan.rows.length };
  });
}

type Db = Parameters<Parameters<typeof withOrgDb>[1]>[0];

/**
 * `undefined` in a drizzle `set` clause is DROPPED, so a corrected file that clears a value would
 * silently leave the old one in place — and a `set` whose every value is undefined throws
 * "No values to set" outright. Nullable columns therefore go through this: absent means NULL,
 * which is what "the corrected file no longer carries it" means.
 */
function clearable<T>(value: T | undefined): T | null {
  return value ?? null;
}

async function writeItems(db: Db, orgId: string, plan: ImportPlan<"items">): Promise<void> {
  // Match on IDENTIFIERS first, in one query for the whole file rather than one per row.
  const wanted = plan.rows.flatMap(({ row }) =>
    identifiersOf(row).map((i) => ({ type: i.type, value: i.value })),
  );
  const existing =
    wanted.length === 0
      ? []
      : await db
          .select({
            itemId: itemIdentifiers.itemId,
            type: itemIdentifiers.type,
            value: itemIdentifiers.value,
          })
          .from(itemIdentifiers)
          .where(
            and(
              eq(itemIdentifiers.orgId, orgId),
              or(
                ...wanted.map((w) =>
                  and(eq(itemIdentifiers.type, w.type), eq(itemIdentifiers.value, w.value)),
                ),
              ),
            ),
          );
  const byIdentifier = new Map(existing.map((e) => [`${e.type}:${e.value}`, e.itemId]));

  for (const { row } of plan.rows) {
    const identifiers = identifiersOf(row);
    // The FIRST identifier that already resolves wins. `identifiersOf` puts the facility's own sku
    // first, so a file that changed nothing matches on the sku and never touches the others.
    const matched = identifiers.map((i) => byIdentifier.get(`${i.type}:${i.value}`)).find(Boolean);

    let itemId: string;
    if (matched) {
      await db
        .update(items)
        .set({
          sku: row.sku,
          name: row.name,
          genericName: clearable(row.generic_name),
          unit: clearable(row.unit),
          notes: clearable(row.notes),
          updatedAt: new Date(),
        })
        .where(and(eq(items.orgId, orgId), eq(items.id, matched)));
      itemId = matched;
    } else {
      const [inserted] = await db
        .insert(items)
        .values({
          orgId,
          sku: row.sku,
          name: row.name,
          genericName: clearable(row.generic_name),
          unit: clearable(row.unit),
          notes: clearable(row.notes),
        })
        // The sku may still collide with an item whose identifiers this file did not mention.
        .onConflictDoUpdate({
          target: [items.orgId, items.sku],
          set: {
            name: row.name,
            genericName: clearable(row.generic_name),
            unit: clearable(row.unit),
            notes: clearable(row.notes),
            updatedAt: new Date(),
          },
        })
        .returning({ id: items.id });
      if (!inserted) throw new Error(`item ${row.sku} was neither inserted nor updated`);
      itemId = inserted.id;
    }

    for (const identifier of identifiers) {
      // Conflict on (org, type, value) rather than (org, item, type): the same NDC must not point
      // at two items within a tenant, and a corrected file that MOVES an identifier from one sku
      // to another has to repoint it rather than fail or duplicate.
      await db
        .insert(itemIdentifiers)
        .values({ orgId, itemId, type: identifier.type, value: identifier.value })
        .onConflictDoUpdate({
          target: [itemIdentifiers.orgId, itemIdentifiers.type, itemIdentifiers.value],
          set: { itemId },
        });
      byIdentifier.set(`${identifier.type}:${identifier.value}`, itemId);
    }

    // Identifiers this item used to carry and the corrected file no longer does are REMOVED. A
    // wrong NDC left behind keeps matching shortage signals to the wrong product, which is the
    // failure this catalog exists to prevent — so a correction has to be able to take one away.
    const keep = identifiers.map((i) => `${i.type}:${i.value}`);
    const stale = await db
      .select({ id: itemIdentifiers.id, type: itemIdentifiers.type, value: itemIdentifiers.value })
      .from(itemIdentifiers)
      .where(and(eq(itemIdentifiers.orgId, orgId), eq(itemIdentifiers.itemId, itemId)));
    const drop = stale.filter((s) => !keep.includes(`${s.type}:${s.value}`));
    if (drop.length > 0) {
      await db.delete(itemIdentifiers).where(
        and(
          eq(itemIdentifiers.orgId, orgId),
          inArray(
            itemIdentifiers.id,
            drop.map((d) => d.id),
          ),
        ),
      );
      for (const d of drop) byIdentifier.delete(`${d.type}:${d.value}`);
    }
  }
}

async function writeSuppliers(db: Db, orgId: string, plan: ImportPlan<"suppliers">): Promise<void> {
  for (const { row } of plan.rows) {
    const [supplier] = await db
      .insert(suppliers)
      .values({ orgId, code: row.supplier_code, name: row.name })
      .onConflictDoUpdate({ target: [suppliers.orgId, suppliers.code], set: { name: row.name } })
      .returning({ id: suppliers.id });
    if (!supplier)
      throw new Error(`supplier ${row.supplier_code} was neither inserted nor updated`);
    if (!row.site_code) continue;

    await db
      .insert(supplierSites)
      .values({
        orgId,
        supplierId: supplier.id,
        code: row.site_code,
        name: clearable(row.site_name),
        country: clearable(row.country),
        leadTimeDays: clearable(row.lead_time_days),
      })
      .onConflictDoUpdate({
        target: [supplierSites.orgId, supplierSites.supplierId, supplierSites.code],
        set: {
          name: clearable(row.site_name),
          country: clearable(row.country),
          leadTimeDays: clearable(row.lead_time_days),
        },
      });
  }
}

async function writeItemSuppliers(
  db: Db,
  orgId: string,
  plan: ImportPlan<"item_suppliers">,
): Promise<void> {
  const itemIds = await skuIndex(
    db,
    orgId,
    plan.rows.map((r) => r.row.sku),
  );
  const supplierIds = await supplierIndex(
    db,
    orgId,
    plan.rows.map((r) => r.row.supplier_code),
  );
  const siteIds = await siteIndex(db, orgId);

  for (const { line, row } of plan.rows) {
    const itemId = itemIds.get(row.sku);
    const supplierId = supplierIds.get(row.supplier_code);
    // A reference to something the catalog does not contain is a DATA error, and it surfaces here
    // rather than as a foreign-key violation, so the message names the line and the missing code.
    if (!itemId) throw new Error(`line ${line}: no item with sku ${row.sku}`);
    if (!supplierId) throw new Error(`line ${line}: no supplier with code ${row.supplier_code}`);

    let siteId: string | undefined;
    if (row.site_code) {
      siteId = siteIds.get(`${supplierId}:${row.site_code}`);
      if (!siteId)
        throw new Error(`line ${line}: no site ${row.site_code} for ${row.supplier_code}`);
    }

    await db
      .insert(itemSuppliers)
      .values({
        orgId,
        itemId,
        supplierId,
        siteId: clearable(siteId),
        contractPrice: clearable(row.contract_price?.toString()),
        preferred: row.preferred,
      })
      .onConflictDoUpdate({
        target: [itemSuppliers.orgId, itemSuppliers.itemId, itemSuppliers.supplierId],
        set: {
          siteId: clearable(siteId),
          contractPrice: clearable(row.contract_price?.toString()),
          preferred: row.preferred,
        },
      });
  }
}

async function writeInventory(db: Db, orgId: string, plan: ImportPlan<"inventory">): Promise<void> {
  const itemIds = await skuIndex(
    db,
    orgId,
    plan.rows.map((r) => r.row.sku),
  );
  const facilityIds = await upsertFacilities(
    db,
    orgId,
    plan.rows.map((r) => ({ code: r.row.facility_code, name: r.row.facility_name })),
  );

  for (const { line, row } of plan.rows) {
    const itemId = itemIds.get(row.sku);
    if (!itemId) throw new Error(`line ${line}: no item with sku ${row.sku}`);
    const facilityId = facilityIds.get(row.facility_code);
    if (!facilityId) throw new Error(`line ${line}: no facility ${row.facility_code}`);
    await db
      .insert(inventorySnapshots)
      .values({
        orgId,
        facilityId,
        itemId,
        onHand: row.on_hand.toString(),
        unit: clearable(row.unit),
        capturedAt: new Date(row.captured_at),
      })
      .onConflictDoUpdate({
        target: [
          inventorySnapshots.orgId,
          inventorySnapshots.facilityId,
          inventorySnapshots.itemId,
          inventorySnapshots.capturedAt,
        ],
        set: { onHand: row.on_hand.toString(), unit: clearable(row.unit) },
      });
  }
}

async function writeProcurement(
  db: Db,
  orgId: string,
  plan: ImportPlan<"procurement">,
): Promise<void> {
  const itemIds = await skuIndex(
    db,
    orgId,
    plan.rows.map((r) => r.row.sku),
  );
  const supplierIds = await supplierIndex(
    db,
    orgId,
    plan.rows.map((r) => r.row.supplier_code).filter((c): c is string => Boolean(c)),
  );
  const facilityIds = await upsertFacilities(
    db,
    orgId,
    plan.rows.map((r) => ({ code: r.row.facility_code })),
  );

  for (const { line, row } of plan.rows) {
    const itemId = itemIds.get(row.sku);
    if (!itemId) throw new Error(`line ${line}: no item with sku ${row.sku}`);
    if (row.supplier_code && !supplierIds.has(row.supplier_code)) {
      throw new Error(`line ${line}: no supplier with code ${row.supplier_code}`);
    }
    const facilityId = facilityIds.get(row.facility_code);
    if (!facilityId) throw new Error(`line ${line}: no facility ${row.facility_code}`);
    const supplierId = row.supplier_code ? supplierIds.get(row.supplier_code) : undefined;

    await db
      .insert(procurementEvents)
      .values({
        orgId,
        facilityId,
        itemId,
        supplierId: clearable(supplierId),
        orderRef: row.order_ref,
        orderedAt: new Date(row.ordered_at),
        quantity: row.quantity.toString(),
        unitCost: clearable(row.unit_cost?.toString()),
      })
      .onConflictDoUpdate({
        target: [
          procurementEvents.orgId,
          procurementEvents.facilityId,
          procurementEvents.itemId,
          procurementEvents.orderedAt,
          procurementEvents.orderRef,
        ],
        set: {
          supplierId: clearable(supplierId),
          quantity: row.quantity.toString(),
          unitCost: clearable(row.unit_cost?.toString()),
        },
      });
  }
}

/**
 * Facilities arrive as a code on an inventory or procurement row rather than in a file of their
 * own, so they are created on first sight — once per DISTINCT code, not once per row.
 *
 * The `set` clause assigns `code` to itself when the file gave no name. It has to set SOMETHING:
 * drizzle drops `undefined` values and then refuses an empty `set` with "No values to set", so a
 * procurement file (which never carries a facility name) would throw before writing a single row.
 * Assigning the conflict key back to itself is the no-op that keeps `RETURNING` giving us the id.
 */
async function upsertFacilities(
  db: Db,
  orgId: string,
  wanted: { code: string; name?: string }[],
): Promise<Map<string, string>> {
  const byCode = new Map<string, string | undefined>();
  for (const w of wanted) {
    // A later row naming the facility beats an earlier one that did not; a blank name never
    // overwrites a name an earlier file supplied.
    if (!byCode.has(w.code) || (w.name && !byCode.get(w.code))) byCode.set(w.code, w.name);
  }

  const out = new Map<string, string>();
  for (const [code, name] of byCode) {
    const [facility] = await db
      .insert(facilities)
      .values({ orgId, code, name: clearable(name) })
      .onConflictDoUpdate({
        target: [facilities.orgId, facilities.code],
        set: name === undefined ? { code } : { name },
      })
      .returning({ id: facilities.id });
    if (!facility) throw new Error(`could not resolve facility ${code}`);
    out.set(code, facility.id);
  }
  return out;
}

/** sku -> item id, resolved in ONE query rather than per row. */
async function skuIndex(db: Db, orgId: string, skus: string[]): Promise<Map<string, string>> {
  if (skus.length === 0) return new Map();
  const rows = await db
    .select({ id: items.id, sku: items.sku })
    .from(items)
    .where(and(eq(items.orgId, orgId), inArray(items.sku, [...new Set(skus)])));
  return new Map(rows.map((r) => [r.sku, r.id]));
}

/** supplier code -> supplier id, resolved in ONE query rather than per row. */
async function supplierIndex(db: Db, orgId: string, codes: string[]): Promise<Map<string, string>> {
  if (codes.length === 0) return new Map();
  const rows = await db
    .select({ id: suppliers.id, code: suppliers.code })
    .from(suppliers)
    .where(and(eq(suppliers.orgId, orgId), inArray(suppliers.code, [...new Set(codes)])));
  return new Map(rows.map((r) => [r.code, r.id]));
}

/** `<supplierId>:<siteCode>` -> site id, for the whole tenant, in ONE query. */
async function siteIndex(db: Db, orgId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({
      id: supplierSites.id,
      supplierId: supplierSites.supplierId,
      code: supplierSites.code,
    })
    .from(supplierSites)
    .where(eq(supplierSites.orgId, orgId));
  return new Map(rows.map((r) => [`${r.supplierId}:${r.code}`, r.id]));
}
