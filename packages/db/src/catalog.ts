import { and, eq, inArray } from "drizzle-orm";
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
 *     re-uploads, and now cannot tell which rows are from which attempt.
 *  2. Everything runs inside `withOrgDb`, which is already a transaction. A failure at row 3,900
 *     of 4,000 rolls the first 3,899 back with it.
 *
 * Re-uploading a corrected file UPDATES rather than duplicates. Every write below is an upsert on
 * the row's natural key — `(org, sku)` for an item, `(org, type, value)` for an identifier,
 * `(org, facility, item, captured_at)` for a snapshot — so the same file applied twice leaves the
 * same rows, and a corrected file changes the rows it corrects.
 */

/** What an import did, per table. Counts, because that is what an operator asks first. */
export interface ImportResult {
  kind: CatalogKind;
  written: number;
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
        return {
          kind: plan.kind,
          written: await writeItems(db, orgId, plan as ImportPlan<"items">),
        };
      case "suppliers":
        return {
          kind: plan.kind,
          written: await writeSuppliers(db, orgId, plan as ImportPlan<"suppliers">),
        };
      case "item_suppliers":
        return {
          kind: plan.kind,
          written: await writeItemSuppliers(db, orgId, plan as ImportPlan<"item_suppliers">),
        };
      case "inventory":
        return {
          kind: plan.kind,
          written: await writeInventory(db, orgId, plan as ImportPlan<"inventory">),
        };
      case "procurement":
        return {
          kind: plan.kind,
          written: await writeProcurement(db, orgId, plan as ImportPlan<"procurement">),
        };
    }
  });
}

type Db = Parameters<Parameters<typeof withOrgDb>[1]>[0];

async function writeItems(db: Db, orgId: string, plan: ImportPlan<"items">): Promise<number> {
  for (const { row } of plan.rows) {
    const [item] = await db
      .insert(items)
      .values({
        orgId,
        sku: row.sku,
        name: row.name,
        genericName: row.generic_name,
        unit: row.unit,
        notes: row.notes,
      })
      .onConflictDoUpdate({
        target: [items.orgId, items.sku],
        set: {
          name: row.name,
          genericName: row.generic_name,
          unit: row.unit,
          notes: row.notes,
          updatedAt: new Date(),
        },
      })
      .returning({ id: items.id });
    if (!item) continue;

    for (const identifier of identifiersOf(row)) {
      // Conflict on (org, type, value) rather than (org, item, type): the same NDC must not point
      // at two items within a tenant, and a corrected file that MOVES an identifier from one sku
      // to another has to repoint it rather than fail or duplicate.
      await db
        .insert(itemIdentifiers)
        .values({ orgId, itemId: item.id, type: identifier.type, value: identifier.value })
        .onConflictDoUpdate({
          target: [itemIdentifiers.orgId, itemIdentifiers.type, itemIdentifiers.value],
          set: { itemId: item.id },
        });
    }
  }
  return plan.rows.length;
}

async function writeSuppliers(
  db: Db,
  orgId: string,
  plan: ImportPlan<"suppliers">,
): Promise<number> {
  for (const { row } of plan.rows) {
    const [supplier] = await db
      .insert(suppliers)
      .values({ orgId, code: row.supplier_code, name: row.name })
      .onConflictDoUpdate({
        target: [suppliers.orgId, suppliers.code],
        set: { name: row.name },
      })
      .returning({ id: suppliers.id });
    if (!supplier || !row.site_code) continue;

    await db
      .insert(supplierSites)
      .values({
        orgId,
        supplierId: supplier.id,
        code: row.site_code,
        name: row.site_name,
        country: row.country,
        leadTimeDays: row.lead_time_days,
      })
      .onConflictDoUpdate({
        target: [supplierSites.orgId, supplierSites.supplierId, supplierSites.code],
        set: { name: row.site_name, country: row.country, leadTimeDays: row.lead_time_days },
      });
  }
  return plan.rows.length;
}

async function writeItemSuppliers(
  db: Db,
  orgId: string,
  plan: ImportPlan<"item_suppliers">,
): Promise<number> {
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

  for (const { line, row } of plan.rows) {
    const itemId = itemIds.get(row.sku);
    const supplierId = supplierIds.get(row.supplier_code);
    // A reference to something the catalog does not contain is a DATA error, and it surfaces here
    // rather than as a foreign-key violation, so the message names the line and the missing code.
    if (!itemId) throw new Error(`line ${line}: no item with sku ${row.sku}`);
    if (!supplierId) throw new Error(`line ${line}: no supplier with code ${row.supplier_code}`);

    let siteId: string | undefined;
    if (row.site_code) {
      const [site] = await db
        .select({ id: supplierSites.id })
        .from(supplierSites)
        .where(
          and(
            eq(supplierSites.orgId, orgId),
            eq(supplierSites.supplierId, supplierId),
            eq(supplierSites.code, row.site_code),
          ),
        );
      if (!site) throw new Error(`line ${line}: no site ${row.site_code} for ${row.supplier_code}`);
      siteId = site.id;
    }

    await db
      .insert(itemSuppliers)
      .values({
        orgId,
        itemId,
        supplierId,
        siteId,
        contractPrice: row.contract_price?.toString(),
        preferred: row.preferred,
      })
      .onConflictDoUpdate({
        target: [itemSuppliers.orgId, itemSuppliers.itemId, itemSuppliers.supplierId],
        set: { siteId, contractPrice: row.contract_price?.toString(), preferred: row.preferred },
      });
  }
  return plan.rows.length;
}

async function writeInventory(
  db: Db,
  orgId: string,
  plan: ImportPlan<"inventory">,
): Promise<number> {
  const itemIds = await skuIndex(
    db,
    orgId,
    plan.rows.map((r) => r.row.sku),
  );
  for (const { line, row } of plan.rows) {
    const itemId = itemIds.get(row.sku);
    if (!itemId) throw new Error(`line ${line}: no item with sku ${row.sku}`);
    const facilityId = await upsertFacility(db, orgId, row.facility_code, row.facility_name);
    await db
      .insert(inventorySnapshots)
      .values({
        orgId,
        facilityId,
        itemId,
        onHand: row.on_hand.toString(),
        unit: row.unit,
        capturedAt: new Date(row.captured_at),
      })
      .onConflictDoUpdate({
        target: [
          inventorySnapshots.orgId,
          inventorySnapshots.facilityId,
          inventorySnapshots.itemId,
          inventorySnapshots.capturedAt,
        ],
        set: { onHand: row.on_hand.toString(), unit: row.unit },
      });
  }
  return plan.rows.length;
}

async function writeProcurement(
  db: Db,
  orgId: string,
  plan: ImportPlan<"procurement">,
): Promise<number> {
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
  for (const { line, row } of plan.rows) {
    const itemId = itemIds.get(row.sku);
    if (!itemId) throw new Error(`line ${line}: no item with sku ${row.sku}`);
    if (row.supplier_code && !supplierIds.has(row.supplier_code)) {
      throw new Error(`line ${line}: no supplier with code ${row.supplier_code}`);
    }
    const facilityId = await upsertFacility(db, orgId, row.facility_code);
    await db
      .insert(procurementEvents)
      .values({
        orgId,
        facilityId,
        itemId,
        supplierId: row.supplier_code ? supplierIds.get(row.supplier_code) : undefined,
        orderedAt: new Date(row.ordered_at),
        quantity: row.quantity.toString(),
        unitCost: row.unit_cost?.toString(),
      })
      .onConflictDoUpdate({
        target: [
          procurementEvents.orgId,
          procurementEvents.facilityId,
          procurementEvents.itemId,
          procurementEvents.orderedAt,
        ],
        set: { quantity: row.quantity.toString(), unitCost: row.unit_cost?.toString() },
      });
  }
  return plan.rows.length;
}

/**
 * Facilities arrive as a code on an inventory or procurement row rather than in a file of their
 * own, so they are created on first sight. `onConflictDoUpdate` rather than `DoNothing` because the
 * insert has to return the id either way.
 */
async function upsertFacility(db: Db, orgId: string, code: string, name?: string): Promise<string> {
  const [facility] = await db
    .insert(facilities)
    .values({ orgId, code, name })
    .onConflictDoUpdate({
      target: [facilities.orgId, facilities.code],
      // A later file that omits the name must not blank a name an earlier file supplied.
      set: { name: name ?? undefined },
    })
    .returning({ id: facilities.id });
  if (!facility) throw new Error(`could not resolve facility ${code}`);
  return facility.id;
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
