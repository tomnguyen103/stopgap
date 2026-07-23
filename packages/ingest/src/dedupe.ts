import type { ShortageRecord } from "@stopgap/core";

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
