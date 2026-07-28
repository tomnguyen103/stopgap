import type { ShortageRecord } from "@stopgap/core";
import type { NormalizedSignal } from "./signal.js";

/** A shortage merged from one or more feed records sharing a dedup key. */
export interface MergedShortage extends ShortageRecord {
  /** Feeds that reported this shortage (e.g. `["openfda","ashp"]`). */
  sources: ShortageRecord["source"][];
  /** Original per-feed records, retained for provenance. */
  contributingRecords: ShortageRecord[];
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** Later of two optional ISO timestamps (undefined sorts first). */
function newer(a: ShortageRecord, b: ShortageRecord): ShortageRecord {
  const ta = a.updatedAt ? Date.parse(a.updatedAt) : -Infinity;
  const tb = b.updatedAt ? Date.parse(b.updatedAt) : -Infinity;
  return tb > ta ? b : a;
}

/**
 * Collapse a batch of normalized signals onto the contract's stable key (ticket 05).
 *
 * The key is already org- and source-scoped, so this merges REPEATS of one record within a poll —
 * a feed listing the same recall under several package configurations, or two pages overlapping —
 * and never merges across tenants or across feeds. Cross-feed correlation ("openFDA and ASHP are
 * both talking about heparin") is a judgement for the layer above; doing it here by key collision
 * would make it an accident.
 *
 * The most recently PUBLISHED signal wins, and match hints union across the group — a duplicate
 * usually differs only by which identifiers it happened to carry, and throwing the extras away
 * would weaken catalog matching for no reason. Ties keep the first occurrence, so the output is a
 * deterministic function of input order.
 */
export function dedupeSignals(signals: NormalizedSignal[]): NormalizedSignal[] {
  const groups = new Map<string, NormalizedSignal[]>();
  for (const s of signals) {
    const list = groups.get(s.dedupeKey);
    if (list) list.push(s);
    else groups.set(s.dedupeKey, [s]);
  }

  const out: NormalizedSignal[] = [];
  for (const group of groups.values()) {
    const base = group.reduce((a, b) => (Date.parse(b.publishedAt) > Date.parse(a.publishedAt) ? b : a));
    out.push({
      ...base,
      matchHints: {
        ndcs: unique(group.flatMap((s) => s.matchHints.ndcs)),
        rxcuis: unique(group.flatMap((s) => s.matchHints.rxcuis)),
        names: unique(group.flatMap((s) => s.matchHints.names)),
      },
    });
  }
  return out;
}

/**
 * Merge records from multiple feeds into one shortage per dedup key (exception-matrix item:
 * duplicate shortage records across feeds). The most recently updated record is the base;
 * NDCs and RxCUIs are unioned across all contributors. A `current` status from any feed
 * wins over `resolved`/`unknown` (conservative: keep the case open if any feed still lists it).
 */
export function mergeRecords(records: ShortageRecord[]): MergedShortage[] {
  const groups = new Map<string, ShortageRecord[]>();
  for (const r of records) {
    const list = groups.get(r.key);
    if (list) list.push(r);
    else groups.set(r.key, [r]);
  }

  const out: MergedShortage[] = [];
  for (const group of groups.values()) {
    const base = group.reduce(newer);
    const anyCurrent = group.some((r) => r.status === "current");
    out.push({
      ...base,
      status: anyCurrent ? "current" : base.status,
      ndcs: unique(group.flatMap((r) => r.ndcs)),
      rxcuis: unique(group.flatMap((r) => r.rxcuis)),
      sources: unique(group.map((r) => r.source)),
      contributingRecords: group,
    });
  }
  return out;
}
