import {
  serializeListParams,
  type ListParams,
  type ListParamsSchema,
} from "./list-params.js";

/**
 * Addresses for an interactive list — the links a sort header, a filter chip and a pager point at.
 *
 * Shared by the signals list and the case queue (tickets 08 and 11). The two lists have different
 * vocabularies and keep their own schemas; what they share is the arithmetic of "the same view with
 * one thing changed", which is identical for both and should not exist twice.
 */

/**
 * This list with one thing changed.
 *
 * Any change other than the page itself returns to page 1: holding page 7 while switching to a
 * filter that matches four rows lands the reader on an empty page they did not ask for.
 */
export function listHref(
  params: ListParams,
  change: Partial<Pick<ListParams, "q" | "sort" | "dir" | "page" | "pageSize" | "filters">>,
  schema: ListParamsSchema,
): string {
  const next: ListParams = {
    ...params,
    ...change,
    page: change.page ?? (Object.keys(change).some((key) => key !== "page") ? 1 : params.page),
  };
  const query = serializeListParams(next, schema);
  return query === "" ? "?" : `?${query}`;
}

/** Clicking the column already sorted on reverses it; clicking another starts at its default. */
export function sortHref(params: ListParams, key: string, schema: ListParamsSchema): string {
  if (params.sort !== key) return listHref(params, { sort: key, dir: "desc" }, schema);
  return listHref(params, { dir: params.dir === "desc" ? "asc" : "desc" }, schema);
}

/**
 * Toggle one filter value — the chip behaviour, expressed as an address.
 *
 * ONE value per key: picking a second value REPLACES the first. The alternative was a chip strip
 * rendering two values as chosen while the query reads one of them, which is a page that lies about
 * what it is showing.
 */
export function toggleFilterHref(
  params: ListParams,
  key: string,
  value: string,
  schema: ListParamsSchema,
): string {
  const active = (params.filters[key] ?? []).includes(value);
  return listHref(params, { filters: { ...params.filters, [key]: active ? [] : [value] } }, schema);
}

/** The one value applied for a filter key, or undefined — what the query layer takes. */
export function filterValue(params: ListParams, key: string): string | undefined {
  return params.filters[key]?.[0];
}

/** Total pages for a row count, never below 1 — an empty list is still page 1 of 1. */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
