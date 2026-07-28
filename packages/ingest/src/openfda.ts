import { createHash } from "node:crypto";
import { getEnv } from "@stopgap/core/env";
import { ShortageRecord } from "@stopgap/core";
import { normalizeKey, normalizeStatus, parseUsDate } from "./normalize.js";
import {
  DEFAULT_SIGNAL_CONFIDENCE,
  classifyStaleness,
  shortageSeverity,
  shortageStatusResolved,
  signalDedupeKey,
  type Connector,
  type NormalizationContext,
  type NormalizedSignal,
} from "./signal.js";

type Fetcher = typeof fetch;

/** Shape of a single openFDA drug-shortage result we depend on (others ignored). */
export interface OpenFdaResult {
  generic_name?: string;
  status?: string;
  update_date?: string;
  package_ndc?: string;
  presentation?: string;
  related_info?: string;
  openfda?: { rxcui?: string[]; product_ndc?: string[] };
}

export interface OpenFdaResponse {
  meta?: { results?: { total?: number } };
  results?: OpenFdaResult[];
}

/** Map one openFDA result into a normalized ShortageRecord. */
export function mapOpenFdaResult(r: OpenFdaResult): ShortageRecord {
  const genericName = r.generic_name?.trim() || "unknown";
  const ndcs = [r.package_ndc, ...(r.openfda?.product_ndc ?? [])].filter((x): x is string => Boolean(x));
  // openFDA has no stable record id. Must NOT include `status` — the same shortage's id
  // would otherwise change on a Current -> Resolved update, breaking the stable-identity
  // contract downstream persistence relies on for upsert. Fall back to a deterministic hash
  // of (generic name + presentation) instead of a shared "no-ndc" collision bucket.
  const sourceId =
    r.package_ndc ?? createHash("sha256").update(`${genericName}:${r.presentation ?? ""}`).digest("hex").slice(0, 16);
  return ShortageRecord.parse({
    source: "openfda",
    sourceId,
    key: normalizeKey(genericName),
    genericName,
    status: normalizeStatus(r.status),
    ndcs,
    rxcuis: r.openfda?.rxcui ?? [],
    note: r.presentation ?? r.related_info,
    updatedAt: parseUsDate(r.update_date),
    raw: r,
  });
}

/**
 * Map one openFDA drug-shortage result onto the normalized signal contract (ticket 05).
 *
 * Built ON TOP of `mapOpenFdaResult` rather than beside it: the stable-identity rule (never fold
 * `status` into the source id, or a Current → Resolved update renames the record) lives there, and
 * a second hand-rolled copy of it here is exactly how a contract migration reintroduces a bug the
 * codebase already fixed.
 */
export function normalizeOpenFdaShortage(
  raw: OpenFdaResult,
  context: NormalizationContext,
): NormalizedSignal {
  const record = mapOpenFdaResult(raw);
  const { severity, severityScore } = shortageSeverity(record.status);
  const publishedAt = record.updatedAt ?? context.fetchedAt;
  const base = getEnv().OPENFDA_BASE_URL.replace(/\/+$/, "");
  return {
    source: "openfda_shortage",
    sourceId: record.sourceId,
    riskDomain: "shortage",
    entityType: "drug",
    entityIdentifier: record.genericName,
    title: `Drug shortage — ${record.genericName}`,
    summary: record.note?.replace(/\s+/g, " ").trim() || "No detail given by the source.",
    severity,
    severityScore,
    confidence: DEFAULT_SIGNAL_CONFIDENCE,
    observedAt: publishedAt,
    publishedAt,
    lastFetchedAt: context.fetchedAt,
    staleness: classifyStaleness(publishedAt, context.fetchedAt),
    sourceResolved: shortageStatusResolved(record.status),
    evidenceUrl: `${base}/drug/shortages.json?search=generic_name:%22${encodeURIComponent(record.genericName)}%22`,
    raw,
    dedupeKey: signalDedupeKey(context.orgId, "openfda_shortage", record.sourceId),
    matchHints: {
      ndcs: [...new Set(record.ndcs)],
      rxcuis: [...new Set(record.rxcuis)],
      names: [...new Set([record.genericName, record.key].filter((n) => n.length > 0))],
    },
  };
}

export const openFdaShortageConnector: Connector<OpenFdaResult> = {
  source: "openfda_shortage",
  riskDomain: "shortage",
  entityType: "drug",
  fetch: (options) => fetchOpenFdaShortages(options),
  normalize: normalizeOpenFdaShortage,
};

/**
 * Poll the live openFDA drug-shortages endpoint. REAL integration (PROJECT_PLAN §5).
 * `search` is an openFDA query string; omit for the full current list (paged).
 */
export async function pollOpenFda(
  opts: { search?: string; limit?: number; fetchImpl?: Fetcher } = {},
): Promise<ShortageRecord[]> {
  return (await fetchOpenFdaShortages(opts)).map(mapOpenFdaResult);
}

/** The raw half of the poll, shared by `pollOpenFda` and the connector's `fetch`. */
async function fetchOpenFdaShortages(
  opts: { search?: string; limit?: number; fetchImpl?: Fetcher } = {},
): Promise<OpenFdaResult[]> {
  const env = getEnv();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const params = new URLSearchParams({ limit: String(opts.limit ?? 100) });
  if (opts.search) params.set("search", opts.search);
  if (env.OPENFDA_API_KEY) params.set("api_key", env.OPENFDA_API_KEY);
  const url = `${env.OPENFDA_BASE_URL}/drug/shortages.json?${params.toString()}`;

  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return []; // openFDA returns 404 for empty result sets
  if (!res.ok) throw new Error(`openFDA poll failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as OpenFdaResponse;
  return body.results ?? [];
}
