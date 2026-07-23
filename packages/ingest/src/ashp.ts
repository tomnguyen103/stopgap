import { getEnv } from "@stopgap/core/env";
import { ShortageRecord } from "@stopgap/core";
import { normalizeKey, normalizeStatus } from "./normalize.js";

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
  return ShortageRecord.parse({
    source: "ashp",
    sourceId: key,
    key: normalizeKey(genericName),
    genericName,
    status: normalizeStatus(s.shortageStatus),
    ndcs,
    rxcuis,
    note: s.lastRevisedDate ? `ASHP revised ${s.lastRevisedDate}` : undefined,
    updatedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : undefined,
    raw: s,
  });
}

/** Map a full ASHP feed object into normalized records. */
export function mapAshpFeed(feed: AshpFeed): ShortageRecord[] {
  const out: ShortageRecord[] = [];
  for (const [key, entry] of Object.entries(feed)) {
    const latest = entry?.latest;
    if (latest) out.push(mapAshpShortage(key, latest));
  }
  return out;
}

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
  const env = getEnv();
  if (!env.ASHP_AUTH_KEY) return [];
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${env.ASHP_BASE_URL}/drugShortages.json?auth=${encodeURIComponent(env.ASHP_AUTH_KEY)}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`ASHP poll failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as AshpFeed | null;
  return body ? mapAshpFeed(body) : [];
}
