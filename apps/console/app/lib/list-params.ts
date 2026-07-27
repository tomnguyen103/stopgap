/**
 * List interaction state — search, filter, sort, pagination — as PURE parse/serialise over a URL
 * query string (unified-platform-spec, Phase F).
 *
 * Two properties are the reason this module exists and neither is cosmetic:
 *
 *  1. **State lives in the URL.** A director can send a colleague a link to exactly the filtered
 *     view they are looking at, the back button behaves, and the server can render the correct
 *     page on first request without a client round-trip. Client-side table behaviour layers on top
 *     for responsiveness but is never the source of truth.
 *
 *  2. **It is pure, so it is the test seam.** Every table behaviour the four dashboards share is
 *     asserted in the offline gate rather than in a browser suite that would break on a class-name
 *     change. Deliberately no framework import, no `server-only`: the same function runs in a
 *     server component and in a client component.
 *
 * The governing rule throughout: **a query string is user-editable and attacker-supplied, so a bad
 * value degrades to a default and never throws.** A list page that 500s on a hand-edited `?page=-1`
 * is a worse outcome than one that shows page 1. The allow-lists are not merely tidiness — `sort`
 * reaches an ORDER BY and `pageSize` bounds how many rows a single request can pull.
 */

/** What a given list allows: which sort keys, which filters and values, which page sizes. */
export interface ListParamsSchema {
  /** Sort keys this list accepts. Anything else falls back to `defaultSort`. */
  readonly sortKeys: readonly string[];
  readonly defaultSort: string;
  readonly defaultDir: SortDir;
  /** Filter key → the values that key accepts. Undeclared keys and values are dropped. */
  readonly filters: Readonly<Record<string, readonly string[]>>;
  /** Page sizes offered. Anything else falls back to `defaultPageSize`. */
  readonly pageSizes: readonly number[];
  readonly defaultPageSize: number;
}

export type SortDir = "asc" | "desc";

/** Parsed, validated list state. Every field is populated; `q` is null when absent. */
export interface ListParams {
  q: string | null;
  sort: string;
  dir: SortDir;
  page: number;
  pageSize: number;
  /** Only keys the schema declares, holding only values the schema allows. */
  filters: Record<string, string[]>;
}

/**
 * Accepted inputs: a raw query string, a `URLSearchParams`, or Next's `searchParams` record
 * (where a repeated param arrives as an array).
 */
export type ListParamsInput = string | URLSearchParams | Record<string, string | string[] | undefined>;

/**
 * Upper bound on a search term. The term reaches a `LIKE`/`ILIKE` predicate, and an unbounded one
 * is free work for anyone who can type a URL. Truncating beats rejecting: a pasted overlong term
 * still returns sensible results instead of an error page.
 */
const MAX_QUERY_LENGTH = 200;

function toSearchParams(input: ListParamsInput): URLSearchParams {
  if (typeof input === "string") return new URLSearchParams(input);
  if (input instanceof URLSearchParams) return input;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) params.append(key, item);
    else params.append(key, value);
  }
  return params;
}

/**
 * Strictly a positive integer in decimal. Deliberately a pattern test rather than `Number(...)`,
 * which would quietly accept `1.5`, `1e3`, ` 1 `, `Infinity` and `0x10` — each of which would
 * become a plausible-looking page number that no user asked for.
 */
function parsePositiveInt(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Values the schema allows, in the order given, without repeats. */
function allowedValues(raw: readonly string[], allowed: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of raw) {
    if (allowed.includes(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

/** Read list state out of a URL. Total: any input yields valid state. */
export function parseListParams(input: ListParamsInput, schema: ListParamsSchema): ListParams {
  const params = toSearchParams(input);

  const rawQuery = params.get("q")?.trim() ?? "";
  const q = rawQuery === "" ? null : rawQuery.slice(0, MAX_QUERY_LENGTH);

  const rawSort = params.get("sort");
  const sort = rawSort !== null && schema.sortKeys.includes(rawSort) ? rawSort : schema.defaultSort;

  const rawDir = params.get("dir")?.toLowerCase();
  const dir: SortDir = rawDir === "asc" || rawDir === "desc" ? rawDir : schema.defaultDir;

  const page = parsePositiveInt(params.get("page")) ?? 1;

  const rawPageSize = parsePositiveInt(params.get("pageSize"));
  const pageSize =
    rawPageSize !== null && schema.pageSizes.includes(rawPageSize) ? rawPageSize : schema.defaultPageSize;

  // Driven by the SCHEMA's keys, never the URL's: an undeclared key cannot enter the result at
  // all, so a crafted `?org_id=...` is invisible here rather than something the query layer has to
  // remember to ignore.
  const filters: Record<string, string[]> = {};
  for (const [key, allowed] of Object.entries(schema.filters)) {
    const values = allowedValues(params.getAll(key), allowed);
    if (values.length > 0) filters[key] = values;
  }

  return { q, sort, dir, page, pageSize, filters };
}

/**
 * Write list state back into a query string.
 *
 * Values equal to the schema default are omitted, so a pristine view has a clean URL and the
 * output is canonical: parsing a hand-edited URL and re-serialising it yields the same string every
 * time, and repeated round-trips never accrete parameters.
 *
 * Emission order is fixed (`q`, `sort`, `dir`, `page`, `pageSize`, then filters in the order the
 * schema declares them) rather than following the caller's object key order, so two callers holding
 * equal state always produce byte-identical URLs — which is what makes a filtered link stable
 * enough to share and to cache.
 */
export function serializeListParams(params: ListParams, schema: ListParamsSchema): string {
  const out = new URLSearchParams();

  if (params.q !== null && params.q.trim() !== "") out.set("q", params.q.trim().slice(0, MAX_QUERY_LENGTH));
  if (params.sort !== schema.defaultSort && schema.sortKeys.includes(params.sort)) out.set("sort", params.sort);
  if (params.dir !== schema.defaultDir) out.set("dir", params.dir);
  if (params.page > 1) out.set("page", String(params.page));
  if (params.pageSize !== schema.defaultPageSize && schema.pageSizes.includes(params.pageSize)) {
    out.set("pageSize", String(params.pageSize));
  }

  for (const [key, allowed] of Object.entries(schema.filters)) {
    for (const value of allowedValues(params.filters[key] ?? [], allowed)) out.append(key, value);
  }

  return out.toString();
}
