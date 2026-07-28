import { z } from "zod";

/**
 * What each catalog CSV means, as schemas over already-split cells.
 *
 * Pure and total: every function here takes strings and returns either a typed row or a reason,
 * never a throw and never a write. That is what lets the whole coercion layer be asserted against
 * literal file contents with no database (ticket 15, "Parsing, coercion and validation are pure
 * and tested directly, separately from the write").
 */

/** The five files an administrator can upload. */
export const CATALOG_KINDS = [
  "items",
  "suppliers",
  "item_suppliers",
  "inventory",
  "procurement",
] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

/**
 * Identifier systems a facility might record a product under. Several may hold at once.
 *
 * The set the spec's catalog story names (NDC, GTIN, UPC, SKU, MPN, FDA application number and
 * RxCUI), plus HIBC, which device catalogs use where drug catalogs use NDC.
 */
export const IDENTIFIER_TYPES = [
  "ndc",
  "rxcui",
  "gtin",
  "upc",
  "hibc",
  "mpn",
  "fda_app_no",
  "sku",
] as const;
export type IdentifierType = (typeof IDENTIFIER_TYPES)[number];

/** A blank optional cell means "not given", never the empty string. */
const optional = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v))
  .optional();

const required = (label: string) => z.string().trim().min(1, `${label} is required`);

/**
 * A quantity from a spreadsheet.
 *
 * Rejects negatives and non-numbers rather than coercing them to 0: an on-hand count that silently
 * became zero reads downstream as "we are out of it", which is the exact wrong answer to give a
 * pharmacist looking at a shortage.
 */
const quantity = (label: string) =>
  z
    .string()
    .trim()
    .transform((v) => v.replace(/,/g, ""))
    .refine((v) => v !== "" && Number.isFinite(Number(v)), `${label} must be a number`)
    .transform(Number)
    .refine((n) => n >= 0, `${label} cannot be negative`);

/**
 * An optional number. `.optional()` on the INPUT as well as the output, because a file that simply
 * has no such column must not fail every row on a value the schema never required.
 */
const optionalNumber = (label: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ?? "").replace(/,/g, ""))
    .transform((v) => (v === "" ? undefined : Number(v)))
    .refine((n) => n === undefined || Number.isFinite(n), `${label} must be a number`);

/** An ISO date or datetime. Kept as an ISO string; the write layer owns the timestamp column. */
const isoDate = (label: string) =>
  z
    .string()
    .trim()
    .refine((v) => v !== "" && !Number.isNaN(Date.parse(v)), `${label} must be an ISO date`)
    .transform((v) => new Date(v).toISOString());

const booleanish = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ?? "").toLowerCase())
  .refine(
    (v) => ["", "true", "false", "yes", "no", "y", "n", "1", "0"].includes(v),
    "must be true or false",
  )
  .transform((v) => ["true", "yes", "y", "1"].includes(v));

export const ItemRow = z.object({
  sku: required("sku"),
  name: required("name"),
  generic_name: optional,
  unit: optional,
  ndc: optional,
  rxcui: optional,
  gtin: optional,
  upc: optional,
  hibc: optional,
  mpn: optional,
  fda_app_no: optional,
  notes: optional,
});
export type ItemRow = z.infer<typeof ItemRow>;

export const SupplierRow = z.object({
  supplier_code: required("supplier_code"),
  name: required("name"),
  site_code: optional,
  site_name: optional,
  country: optional,
  lead_time_days: optionalNumber("lead_time_days"),
});
export type SupplierRow = z.infer<typeof SupplierRow>;

export const ItemSupplierRow = z.object({
  sku: required("sku"),
  supplier_code: required("supplier_code"),
  site_code: optional,
  contract_price: optionalNumber("contract_price"),
  preferred: booleanish,
});
export type ItemSupplierRow = z.infer<typeof ItemSupplierRow>;

export const InventoryRow = z.object({
  facility_code: required("facility_code"),
  facility_name: optional,
  sku: required("sku"),
  on_hand: quantity("on_hand"),
  unit: optional,
  captured_at: isoDate("captured_at"),
});
export type InventoryRow = z.infer<typeof InventoryRow>;

export const ProcurementRow = z.object({
  facility_code: required("facility_code"),
  sku: required("sku"),
  supplier_code: optional,
  /**
   * The purchase-order (or line) reference, when the file carries one.
   *
   * It is what makes one order distinguishable from another placed for the same item, at the same
   * facility, on the same date — which is common once a file gives dates rather than datetimes.
   * Without it two genuine orders are indistinguishable IN THE DATA, and the import treats them as
   * one restatement rather than inventing a difference the file does not contain.
   */
  order_ref: z
    .string()
    .trim()
    .optional()
    .transform((v) => v ?? ""),
  ordered_at: isoDate("ordered_at"),
  quantity: quantity("quantity"),
  unit_cost: optionalNumber("unit_cost"),
});
export type ProcurementRow = z.infer<typeof ProcurementRow>;

const SCHEMAS = {
  items: ItemRow,
  suppliers: SupplierRow,
  item_suppliers: ItemSupplierRow,
  inventory: InventoryRow,
  procurement: ProcurementRow,
} as const;

/** Columns a file of each kind must contain before any row is worth looking at. */
export const REQUIRED_COLUMNS: Record<CatalogKind, string[]> = {
  items: ["sku", "name"],
  suppliers: ["supplier_code", "name"],
  item_suppliers: ["sku", "supplier_code"],
  inventory: ["facility_code", "sku", "on_hand", "captured_at"],
  procurement: ["facility_code", "sku", "ordered_at", "quantity"],
};

export type CatalogRow = {
  items: ItemRow;
  suppliers: SupplierRow;
  item_suppliers: ItemSupplierRow;
  inventory: InventoryRow;
  procurement: ProcurementRow;
};

/**
 * The identifiers one item row carries, as (type, value) pairs.
 *
 * A facility's own `sku` is included as an identifier in its own right — it is how that facility
 * records the product, which is precisely what an identifier is, and it is the key a corrected
 * re-upload matches on.
 */
export function itemIdentifiers(row: ItemRow): { type: IdentifierType; value: string }[] {
  const pairs: { type: IdentifierType; value: string | undefined }[] = [
    { type: "sku", value: row.sku },
    { type: "ndc", value: row.ndc },
    { type: "rxcui", value: row.rxcui },
    { type: "gtin", value: row.gtin },
    { type: "upc", value: row.upc },
    { type: "hibc", value: row.hibc },
    { type: "mpn", value: row.mpn },
    { type: "fda_app_no", value: row.fda_app_no },
  ];
  return pairs.filter((p): p is { type: IdentifierType; value: string } => Boolean(p.value));
}

/** Coerce one record against its kind's schema. Returns the reason rather than throwing. */
export function coerceRow<K extends CatalogKind>(
  kind: K,
  record: Record<string, string>,
): { ok: true; row: CatalogRow[K] } | { ok: false; column?: string; reason: string } {
  const result = SCHEMAS[kind].safeParse(record);
  if (result.success) return { ok: true, row: result.data as CatalogRow[K] };
  const issue = result.error.issues[0];
  return {
    ok: false,
    column: issue?.path[0] === undefined ? undefined : String(issue.path[0]),
    reason: issue?.message ?? "invalid row",
  };
}
