import { getEnv } from "@stopgap/core/env";
import { parseCompactDate } from "./normalize.js";
import {
  DEFAULT_SIGNAL_CONFIDENCE,
  classifyStaleness,
  signalDedupeKey,
  type Connector,
  type EntityType,
  type NormalizationContext,
  type NormalizedSignal,
  type Severity,
  type SignalSource,
} from "./signal.js";

type Fetcher = typeof fetch;

/**
 * openFDA enforcement (recall) records, drug and device.
 *
 * ONE normalizer serves both: the two endpoints return the same document shape and differ only in
 * which openFDA identifier block is populated. Two copies would drift on the field that matters
 * (the recall classification) for no gain.
 *
 * There is no device-SHORTAGE endpoint to adopt — `/device/shortages.json` returns 404 ("Cannot
 * GET"), verified live against api.fda.gov. Device coverage therefore arrives as recalls, which is
 * the hazard this product actually acts on: substituting into a recalled device is the failure the
 * pipeline exists to prevent.
 */

/** The subset of an openFDA enforcement result this connector depends on (others ignored). */
export interface OpenFdaEnforcementResult {
  recall_number?: string;
  event_id?: string;
  status?: string;
  classification?: string;
  product_description?: string;
  reason_for_recall?: string;
  recalling_firm?: string;
  recall_initiation_date?: string;
  center_classification_date?: string;
  termination_date?: string;
  report_date?: string;
  openfda?: {
    rxcui?: string[];
    product_ndc?: string[];
    package_ndc?: string[];
    generic_name?: string[];
    brand_name?: string[];
    device_name?: string;
  };
}

export interface OpenFdaEnforcementResponse {
  results?: OpenFdaEnforcementResult[];
}

/**
 * FDA recall classification mapped onto the contract's severity pair.
 *
 * The classification IS a severity judgement made by the regulator — Class I means a reasonable
 * probability of serious harm or death, Class III means unlikely to cause harm — so it is carried
 * across rather than re-derived from the free-text reason. An unrecognised or missing class lands
 * at `moderate`, not `low`: an unclassified recall is unknown, not benign.
 */
export function recallSeverity(classification: string | undefined): {
  severity: Severity;
  severityScore: number;
} {
  const c = (classification ?? "").toLowerCase();
  if (c.includes("class i") && !c.includes("class ii")) return { severity: "critical", severityScore: 0.95 };
  if (c.includes("class ii") && !c.includes("class iii")) return { severity: "high", severityScore: 0.6 };
  if (c.includes("class iii")) return { severity: "moderate", severityScore: 0.3 };
  return { severity: "moderate", severityScore: 0.4 };
}

/**
 * Whether the FDA considers this recall over.
 *
 * `Terminated` and `Completed` are the provider's two done states; `Ongoing` and `Pending` are not.
 * This is the contract's `sourceResolved` — a WEIGHTING input — and is deliberately NOT the same
 * question as whether the record still appears in the feed.
 */
export function recallResolved(status: string | undefined): boolean {
  const s = (status ?? "").toLowerCase();
  return s === "terminated" || s === "completed";
}

/** Latest of a set of `YYYYMMDD` provider dates, as ISO 8601, or undefined when none parse. */
function latestDate(values: (string | undefined)[]): string | undefined {
  const parsed = values.map(parseCompactDate).filter((x): x is string => Boolean(x));
  if (parsed.length === 0) return undefined;
  return parsed.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

function unique(xs: (string | undefined)[]): string[] {
  return [...new Set(xs.filter((x): x is string => typeof x === "string" && x.trim().length > 0))];
}

/** Collapse whitespace and clip to a headline length, without cutting mid-escape. */
function headline(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Where a human verifies the claim: the provider's own record, queried by recall number.
 *
 * Built from the CONFIGURED base URL rather than a hardcoded host, so an evidence link always
 * points at the endpoint the data actually came from. That makes the normalizer a function of
 * (payload, context, configuration) rather than of ambient time or network — still deterministic,
 * which is what the offline gate and the scorer need.
 */
function evidenceUrl(path: string, recallNumber: string): string {
  const base = getEnv().OPENFDA_BASE_URL.replace(/\/+$/, "");
  return `${base}/${path}/enforcement.json?search=recall_number:%22${encodeURIComponent(recallNumber)}%22`;
}

function normalizeEnforcement(
  raw: OpenFdaEnforcementResult,
  context: NormalizationContext,
  spec: { source: SignalSource; entityType: EntityType; path: string },
): NormalizedSignal {
  const description = raw.product_description?.trim() ?? "";
  const genericName = raw.openfda?.generic_name?.[0]?.trim();
  const deviceName = raw.openfda?.device_name?.trim();
  // recall_number is the FDA's stable per-recall identifier and survives status updates. event_id
  // groups several recall numbers under one event, so it is a fallback only — never the first
  // choice, or two distinct recalls from one event would collapse into a single signal.
  const sourceId = raw.recall_number?.trim() || raw.event_id?.trim() || "";
  const { severity, severityScore } = recallSeverity(raw.classification);
  const publishedAt =
    latestDate([raw.report_date, raw.center_classification_date, raw.termination_date]) ??
    parseCompactDate(raw.recall_initiation_date) ??
    context.fetchedAt;
  const observedAt = parseCompactDate(raw.recall_initiation_date) ?? publishedAt;
  const entityIdentifier = (spec.entityType === "drug" ? genericName : deviceName) || description || "unknown";

  return {
    source: spec.source,
    sourceId,
    riskDomain: "recall",
    entityType: spec.entityType,
    entityIdentifier,
    title: `${raw.classification?.trim() || "Unclassified"} recall — ${headline(description || entityIdentifier)}`,
    summary: raw.reason_for_recall?.replace(/\s+/g, " ").trim() || "No reason given by the source.",
    severity,
    severityScore,
    confidence: DEFAULT_SIGNAL_CONFIDENCE,
    observedAt,
    publishedAt,
    lastFetchedAt: context.fetchedAt,
    staleness: classifyStaleness(publishedAt, context.fetchedAt),
    sourceResolved: recallResolved(raw.status),
    evidenceUrl: evidenceUrl(spec.path, sourceId),
    raw,
    dedupeKey: signalDedupeKey(context.orgId, spec.source, sourceId),
    matchHints: {
      ndcs: unique([...(raw.openfda?.package_ndc ?? []), ...(raw.openfda?.product_ndc ?? [])]),
      rxcuis: unique(raw.openfda?.rxcui ?? []),
      names: unique([genericName, deviceName, ...(raw.openfda?.brand_name ?? []), description || undefined]),
    },
  };
}

/** Poll one openFDA enforcement endpoint. Impure by nature; the normalizer above is not. */
async function pollEnforcement(
  path: string,
  opts: { limit?: number; fetchImpl?: Fetcher } = {},
): Promise<OpenFdaEnforcementResult[]> {
  const env = getEnv();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const params = new URLSearchParams({ limit: String(opts.limit ?? 100) });
  if (env.OPENFDA_API_KEY) params.set("api_key", env.OPENFDA_API_KEY);
  const url = `${env.OPENFDA_BASE_URL}/${path}/enforcement.json?${params.toString()}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return []; // openFDA answers 404 for an empty result set, not an error
  if (!res.ok) throw new Error(`openFDA ${path} enforcement poll failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as OpenFdaEnforcementResponse;
  return body.results ?? [];
}

export const openFdaDrugRecallConnector: Connector<OpenFdaEnforcementResult> = {
  source: "openfda_drug_recall",
  riskDomain: "recall",
  entityType: "drug",
  fetch: (options) => pollEnforcement("drug", options),
  normalize: (raw, context) =>
    normalizeEnforcement(raw, context, { source: "openfda_drug_recall", entityType: "drug", path: "drug" }),
};

export const openFdaDeviceRecallConnector: Connector<OpenFdaEnforcementResult> = {
  source: "openfda_device_recall",
  riskDomain: "recall",
  entityType: "device",
  fetch: (options) => pollEnforcement("device", options),
  normalize: (raw, context) =>
    normalizeEnforcement(raw, context, { source: "openfda_device_recall", entityType: "device", path: "device" }),
};
