import { createHash } from "node:crypto";
import type { ShortageStatus } from "@stopgap/core";

/** Cross-feed dedup key: lowercased, punctuation-stripped, whitespace-collapsed. */
export function normalizeKey(genericName: string): string {
  return genericName
    .toLowerCase()
    .replace(/\b(injection|capsule|tablet|solution|delayed release|for injection)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Map heterogeneous feed status strings to the normalized enum. */
export function normalizeStatus(raw: string | undefined): ShortageStatus {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("resolved")) return "resolved";
  if (s.includes("current") || s.includes("active") || s.includes("discontinu") || s.includes("shortage"))
    return "current";
  return "unknown";
}

/** Parse openFDA's `MM/DD/YYYY` date to an ISO 8601 string, or undefined if unparseable. */
export function parseUsDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!m) return undefined;
  const [, mm, dd, yyyy] = m;
  const date = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Stable content hash of a normalized payload, for skip-if-unchanged dedup. */
export function contentHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
