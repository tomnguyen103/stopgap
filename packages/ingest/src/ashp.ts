import { getEnv } from "@stopgap/core/env";
import { ShortageRecord } from "@stopgap/core";
import { normalizeKey, normalizeStatus } from "./normalize.js";
import {
  shortageSignal,
  type Connector,
  type NormalizationContext,
  type NormalizedSignal,
} from "./signal.js";

type Fetcher = typeof fetch;

/** One product entry in an ASHP shortage (affected or available). */
export interface AshpProduct {
  ndc?: string;
  rxcui?: string;
  description?: string;
}

/** The `latest` version of an ASHP shortage record (documented shape). */
export interface AshpShortage {
  shortageTitle?: string;
  shortageStatus?: string;
  lastRevisedDate?: string;
  updatedAt?: number;
  affectedProduct?: AshpProduct[];
  availableProduct?: AshpProduct[];
}

/** `/drugShortages.json` returns an object keyed by shortage id, each with a `latest`. */
export type AshpFeed = Record<string, { latest?: AshpShortage } | null>;

/** Map one ASHP shortage (its feed key + latest version) into a ShortageRecord. */
export function mapAshpShortage(key: string, s: AshpShortage): ShortageRecord {
  const genericName = s.shortageTitle?.trim() || "unknown";
  const products = [...(s.affectedProduct ?? []), ...(s.availableProduct ?? [])];
  const ndcs = products.map((p) => p.ndc).filter((x): x is string => Boolean(x));
  const rxcuis = [...new Set(products.map((p) => p.rxcui).filter((x): x is string => Boolean(x)))];
  // A malformed/out-of-range epoch would make toISOString() throw and abort the whole poll;
  // fall back to undefined instead of failing every record over one bad timestamp.
  const updatedAtDate = typeof s.updatedAt === "number" ? new Date(s.updatedAt) : undefined;
  const updatedAt =
    updatedAtDate && !Number.isNaN(updatedAtDate.getTime())
      ? updatedAtDate.toISOString()
      : undefined;
  return ShortageRecord.parse({
    source: "ashp",
    sourceId: key,
    key: normalizeKey(genericName),
    genericName,
    status: normalizeStatus(s.shortageStatus),
    ndcs,
    rxcuis,
    note: s.lastRevisedDate ? `ASHP revised ${s.lastRevisedDate}` : undefined,
    updatedAt,
    raw: s,
  });
}

/** Map a full ASHP feed object into normalized records. */
export function mapAshpFeed(feed: AshpFeed): ShortageRecord[] {
  return ashpEntries(feed).map((e) => mapAshpShortage(e.key, e.shortage));
}

/**
 * One ASHP shortage paired with its feed key.
 *
 * The contract's `normalize` takes a single raw record, but ASHP's identity lives in the object KEY
 * rather than in the record — so the connector's raw type is the pair. Flattening at fetch time
 * keeps the normalizer a one-argument pure function like every other connector's.
 */
export interface AshpEntry {
  key: string;
  shortage: AshpShortage;
}

/** Flatten an ASHP feed object into keyed entries, dropping versionless placeholders. */
export function ashpEntries(feed: AshpFeed): AshpEntry[] {
  const out: AshpEntry[] = [];
  for (const [key, entry] of Object.entries(feed)) {
    const latest = entry?.latest;
    if (latest) out.push({ key, shortage: latest });
  }
  return out;
}

/**
 * ASHP's public shortage index.
 *
 * The machine feed is auth-gated and exposes no per-record public URL, so the evidence link is the
 * index a pharmacist can actually open. Coarser than the openFDA links by necessity — a fabricated
 * deep-link pattern would look more precise and verify nothing.
 */
export const ASHP_EVIDENCE_URL = "https://www.ashp.org/drug-shortages/current-shortages";

/** Map one keyed ASHP entry onto the normalized signal contract (ticket 05). */
export function normalizeAshpShortage(
  raw: AshpEntry,
  context: NormalizationContext,
): NormalizedSignal {
  return shortageSignal(
    mapAshpShortage(raw.key, raw.shortage),
    { source: "ashp_shortage", evidenceUrl: ASHP_EVIDENCE_URL, raw: raw.shortage },
    context,
  );
}

export const ashpShortageConnector: Connector<AshpEntry> = {
  source: "ashp_shortage",
  riskDomain: "shortage",
  entityType: "drug",
  // ASHP serves the whole shortage list as ONE document with no server-side paging, so `limit`
  // can only be honoured by trimming after the fetch. Trimming is still worth doing — the option
  // is on the contract, and silently ignoring it would let a caller believe it bounded the work.
  fetch: async (options) => {
    const entries = ashpEntries(await fetchAshpFeed(options?.fetchImpl));
    return options?.limit === undefined ? entries : entries.slice(0, options.limit);
  },
  normalize: normalizeAshpShortage,
};

/** True when the ASHP poller cannot run because no auth key is configured. */
export function ashpStubbed(): boolean {
  return !getEnv().ASHP_AUTH_KEY;
}

/**
 * Poll the live ASHP AHFS drug-shortages feed. REAL integration (PROJECT_PLAN §5), but the
 * feed requires an auth key; absent `ASHP_AUTH_KEY` this returns `[]` (stubbed — see
 * PHASE5-TODO.md). Tests exercise the mappers against a recorded fixture.
 */
export async function pollAshp(opts: { fetchImpl?: Fetcher } = {}): Promise<ShortageRecord[]> {
  return mapAshpFeed(await fetchAshpFeed(opts.fetchImpl));
}

/**
 * The raw half of the poll, shared by `pollAshp` and the connector's `fetch`.
 *
 * Absent `ASHP_AUTH_KEY` this returns an EMPTY feed rather than throwing or pretending — the
 * repository's honest-unconfigured stance (see PHASE5-TODO.md). A missing key is a deployment fact,
 * not a poll failure.
 */
async function fetchAshpFeed(fetchImpl: Fetcher = fetch): Promise<AshpFeed> {
  const env = getEnv();
  if (!env.ASHP_AUTH_KEY) return {};
  const url = `${env.ASHP_BASE_URL}/drugShortages.json?auth=${encodeURIComponent(env.ASHP_AUTH_KEY)}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`ASHP poll failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as AshpFeed | null;
  return body ?? {};
}
