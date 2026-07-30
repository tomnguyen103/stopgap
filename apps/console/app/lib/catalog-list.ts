import { CATALOG_KINDS } from "@stopgap/catalog";

import { parseListParams, type ListParams, type ListParamsSchema } from "./list-params.js";

/**
 * The administrator's catalog list, as data (ticket 17).
 *
 * Its own schema rather than a shared one, for the reason the signals list and the case queue keep
 * theirs apart: a schema serving several lists has to allow every value any of them accepts, which
 * is how a filter that returns nothing forever gets shipped.
 */
export const CATALOG_LIST_SCHEMA: ListParamsSchema = {
  sortKeys: ["name", "sku", "suppliers"],
  defaultSort: "name",
  defaultDir: "asc",
  filters: {
    // Sole-sourced items are the ones a shortage has no second route around, so "show me only
    // those" is the question this list is opened to answer. `unsourced` is offered beside it
    // because the two are different problems with different fixes.
    sourcing: ["sole", "multi", "unsourced"],
  },
  pageSizes: [25, 50, 100],
  defaultPageSize: 25,
};

export function parseCatalogListParams(
  input: Parameters<typeof parseListParams>[0],
): ListParams {
  return parseListParams(input, CATALOG_LIST_SCHEMA);
}

/** The upload kinds the console offers, in the order the files depend on each other. */
export const UPLOAD_KINDS = CATALOG_KINDS;

/**
 * How many supplier sites make an item sole-sourced.
 *
 * EXACTLY one. An item with no supplier loaded is not sole-sourced — it is unsourced, which is a
 * gap in the catalog rather than a fact about the supply chain, and badging it as sole-sourced
 * would put a data-entry omission on the same list as a genuine single point of failure.
 */
export const SOLE_SOURCE_SITES = 1;

export function isSoleSourced(supplierSiteCount: number): boolean {
  return supplierSiteCount === SOLE_SOURCE_SITES;
}

/** No supplier loaded at all — a hole in the catalog, reported as one. */
export function isUnsourced(supplierSiteCount: number): boolean {
  return supplierSiteCount === 0;
}

/**
 * A per-row import failure, phrased for the person who has to fix the file.
 *
 * The LINE first, because that is what a spreadsheet shows in its margin, and the column when the
 * plan could identify one. A message that names only the reason sends an administrator hunting
 * through four thousand rows for it.
 */
export function describeRowError(error: {
  line: number;
  column?: string;
  reason: string;
}): string {
  return error.column === undefined
    ? `Line ${String(error.line)}: ${error.reason}`
    : `Line ${String(error.line)}, column “${error.column}”: ${error.reason}`;
}

/**
 * What one catalog upload may weigh.
 *
 * SHARED, because it is enforced twice — in the panel so a mistake is caught before a multi-megabyte
 * round trip, and again in the server action, which is the one that actually binds. Written out in
 * both places it was one edit away from disagreeing, and the disagreement is silent: the panel would
 * accept a file the action then refuses, with the reason arriving as a zod error.
 */
export const MAX_UPLOAD_BYTES = 8_000_000;
