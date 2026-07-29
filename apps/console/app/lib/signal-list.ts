import { RISK_DOMAINS, SEVERITIES, STALENESS } from "@stopgap/ingest";
import { COMPONENT_BUDGET, type ComponentName } from "@stopgap/scorer";

import {
  parseListParams,
  serializeListParams,
  type ListParams,
  type ListParamsSchema,
} from "./list-params.js";

/**
 * The viewer's signals list, as data rather than as markup (ticket 08).
 *
 * Everything here is pure and framework-free, so the behaviours the ticket is actually judged on —
 * a shared link reproduces a view, a hand-edited address degrades instead of erroring, a partial
 * score says so — are asserted in the offline gate rather than in a browser suite that breaks on a
 * class name.
 */

/**
 * What the signals list accepts.
 *
 * The filter values ARE the contract's constants, imported rather than transcribed: a hand-copied
 * list drifts the first time the contract gains a value, and a value this schema allows but the
 * database never stores is a filter that silently returns nothing for good.
 *
 * `sortKeys` names only the columns the table actually renders a header for. The query layer knows
 * more keys than these; offering one the page cannot show is a sort no reader can undo.
 *
 * `pageSizes` is reachable only by editing the address. It is an allow-list rather than a control:
 * what it bounds is how many rows one request can pull.
 */
export const SIGNAL_LIST_SCHEMA: ListParamsSchema = {
  sortKeys: ["published", "severity", "entity"],
  defaultSort: "published",
  defaultDir: "desc",
  filters: {
    domain: RISK_DOMAINS,
    severity: SEVERITIES,
    freshness: STALENESS,
  },
  pageSizes: [25, 50, 100],
  defaultPageSize: 25,
};

export function parseSignalListParams(
  input: Parameters<typeof parseListParams>[0],
): ListParams {
  return parseListParams(input, SIGNAL_LIST_SCHEMA);
}

/**
 * The address for this list with one thing changed — what every sort header, filter chip and pager
 * link points at.
 *
 * Any change other than the page itself resets to page 1: holding page 7 while switching to a
 * filter that matches four rows lands the reader on an empty page they did not ask for.
 */
export function signalListHref(
  params: ListParams,
  change: Partial<Pick<ListParams, "q" | "sort" | "dir" | "page" | "pageSize" | "filters">>,
): string {
  const next: ListParams = {
    ...params,
    ...change,
    page: change.page ?? (Object.keys(change).some((k) => k !== "page") ? 1 : params.page),
  };
  const query = serializeListParams(next, SIGNAL_LIST_SCHEMA);
  return query === "" ? "?" : `?${query}`;
}

/** Clicking the column already sorted on reverses it; clicking another starts at its default. */
export function sortHref(params: ListParams, key: string): string {
  if (params.sort !== key) return signalListHref(params, { sort: key, dir: "desc" });
  return signalListHref(params, { dir: params.dir === "desc" ? "asc" : "desc" });
}

/**
 * Toggle one filter value — the chip behaviour, expressed as an address.
 *
 * ONE value per key: picking a second domain REPLACES the first rather than adding to it. The
 * alternative was a chip strip that renders two domains as chosen while the query reads one of
 * them, which is a page that lies about what it is showing.
 */
export function toggleFilterHref(params: ListParams, key: string, value: string): string {
  const active = (params.filters[key] ?? []).includes(value);
  return signalListHref(params, {
    filters: { ...params.filters, [key]: active ? [] : [value] },
  });
}

/** The one value applied for a filter key, or undefined — what the query layer takes. */
export function filterValue(params: ListParams, key: string): string | undefined {
  return params.filters[key]?.[0];
}

/** The scorer's bands and the console's severity ramp share names; anything else stays neutral. */
export function bandSeverity(band: string | null): "critical" | "high" | "moderate" | "low" | "none" {
  return band === "critical" || band === "high" || band === "moderate" || band === "low"
    ? band
    : "none";
}

/** Total pages for a row count, never below 1 — an empty list is still page 1 of 1. */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * Which score components carried no weight in a snapshot, and why.
 *
 * Read off the snapshot's own component map rather than a constant: the dormant set is a property
 * of the score that was computed, so a snapshot taken after catalog data lands reports fewer dark
 * components without this function being edited. A component present with a zero value is NOT
 * dormant — the scorer looked and found nothing — so only absent keys are reported.
 */
export function dormantComponents(components: Record<string, number> | null): ComponentName[] {
  if (components === null) return [];
  return (Object.keys(COMPONENT_BUDGET) as ComponentName[]).filter(
    (name) => !Object.hasOwn(components, name),
  );
}

/** The points a score could not reach, given which components were dormant. */
export function dormantPoints(components: Record<string, number> | null): number {
  return dormantComponents(components).reduce((sum, name) => sum + COMPONENT_BUDGET[name], 0);
}

const COMPONENT_LABELS: Record<ComponentName, string> = {
  signalExposure: "Signal exposure",
  daysOnHand: "Days on hand",
  soleSource: "Sole source",
};

export function componentLabel(name: ComponentName): string {
  return COMPONENT_LABELS[name];
}

/**
 * The sentence a partial score has to carry.
 *
 * Returns null when nothing is dormant, so the notice disappears the moment the score is whole
 * rather than becoming furniture nobody reads.
 */
export function partialScoreNotice(components: Record<string, number> | null): string | null {
  const dormant = dormantComponents(components);
  if (dormant.length === 0) return null;
  const names = dormant.map((name) => COMPONENT_LABELS[name].toLowerCase());
  const listed =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `Scored out of ${100 - dormantPoints(components)} of 100: ${listed} stay dark until catalog data is loaded.`;
}
