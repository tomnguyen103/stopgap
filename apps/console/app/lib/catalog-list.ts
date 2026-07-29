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
    // those" is the question this list is opened to answer.
    sourcing: ["sole", "multi"],
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
 * One. Stated here rather than inline in a query so the list, the badge and the item page cannot
 * disagree about what the word means.
 */
export const SOLE_SOURCE_MAX_SITES = 1;

export function isSoleSourced(supplierSiteCount: number): boolean {
  return supplierSiteCount <= SOLE_SOURCE_MAX_SITES;
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
