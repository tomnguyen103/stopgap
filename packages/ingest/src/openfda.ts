import { createHash } from "node:crypto";
import { getEnv } from "@stopgap/core/env";
import { ShortageRecord } from "@stopgap/core";
import { normalizeKey, normalizeStatus, parseUsDate } from "./normalize.js";

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
 * Poll the live openFDA drug-shortages endpoint. REAL integration (PROJECT_PLAN §5).
 * `search` is an openFDA query string; omit for the full current list (paged).
 */
export async function pollOpenFda(
  opts: { search?: string; limit?: number; fetchImpl?: Fetcher } = {},
): Promise<ShortageRecord[]> {
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
  return (body.results ?? []).map(mapOpenFdaResult);
}
