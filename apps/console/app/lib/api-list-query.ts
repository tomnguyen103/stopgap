import { RISK_DOMAINS, SEVERITIES } from "@stopgap/ingest";
import { SCORE_BANDS } from "@stopgap/scorer";
import { parseListParams, type ListParamsSchema, type SortDir } from "./list-params";

/**
 * The `/api/v1` list vocabulary for signals, scores and catalog items (ticket 19).
 *
 * ONE vocabulary, shared with the console rather than reinvented: the schemas below feed the same
 * pure `parseListParams` the dashboards use, so `?q=…&sort=…&dir=…&page=…&pageSize=…` means the
 * same thing in a shared console link and in an integrator's client. An endpoint that grew its own
 * `?limit=` would look like it worked — rows come back either way — while quietly ignoring the
 * filters a caller copied out of the browser.
 *
 * TOTALITY IS THE CONTRACT. `parseListParams` never throws: an unusable `sort`, `dir`, `page` or
 * `pageSize` degrades to the default, and an undeclared filter key or value is dropped. So these
 * endpoints have no 400 — the query string cannot fail validation, only be partly ignored. That is
 * deliberate and differs from the older `?limit=` endpoints, which validate one number and refuse:
 * a filter allow-list has no honest 400 to give when a client sends a value from a NEWER server's
 * vocabulary, and answering "your filter is invalid" to a forward-compatible client is worse than
 * answering with the unfiltered rows it can see for itself.
 *
 * The allow-lists are enforcement, not documentation: `sort` reaches an ORDER BY, `pageSize`
 * bounds the rows one request can pull, and `page` reaches an OFFSET Postgres computes and
 * discards. Nothing outside these lists reaches the query layer.
 */

/** Page sizes every list offers. The same three the console's tables use. */
const PAGE_SIZES = [25, 50, 100] as const;

export const API_LIST_SCHEMAS = {
  signals: {
    sortKeys: ["publishedAt", "observedAt", "severityScore", "title"],
    defaultSort: "publishedAt",
    defaultDir: "desc",
    filters: { riskDomain: RISK_DOMAINS, severity: SEVERITIES },
    pageSizes: PAGE_SIZES,
    defaultPageSize: 50,
  },
  /**
   * Ranked on the SCORER's number, never on `risk_signals.severity_score` (the ingest heuristic) —
   * the same rule the daily brief and every console score display follow.
   */
  scores: {
    sortKeys: ["score", "computedAt"],
    defaultSort: "score",
    defaultDir: "desc",
    filters: { band: SCORE_BANDS },
    pageSizes: PAGE_SIZES,
    defaultPageSize: 50,
  },
  catalogItems: {
    sortKeys: ["sku", "name", "updatedAt"],
    defaultSort: "sku",
    defaultDir: "asc",
    filters: {},
    pageSizes: PAGE_SIZES,
    defaultPageSize: 50,
  },
} as const satisfies Record<string, ListParamsSchema>;

export type ApiListResource = keyof typeof API_LIST_SCHEMAS;

/**
 * A parsed list request, already in the shape the query layer takes: `limit`/`offset` rather than
 * `page`/`pageSize`, so the offset arithmetic happens once here instead of in each route.
 */
export interface ApiListQuery {
  q: string | null;
  sort: string;
  dir: SortDir;
  page: number;
  pageSize: number;
  limit: number;
  offset: number;
  filters: Record<string, string[]>;
}

export function parseApiListQuery(resource: ApiListResource, url: URL): ApiListQuery {
  const schema = API_LIST_SCHEMAS[resource];
  const params = parseListParams(url.searchParams, schema);
  return {
    ...params,
    limit: params.pageSize,
    offset: (params.page - 1) * params.pageSize,
  };
}

/** The pagination block every list response carries, so a client can page without guessing. */
export interface ApiPageMeta {
  page: number;
  pageSize: number;
  total: number;
}

export function pageMeta(query: ApiListQuery, total: number): ApiPageMeta {
  return { page: query.page, pageSize: query.pageSize, total };
}
