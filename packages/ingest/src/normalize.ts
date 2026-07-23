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
  const month = Number(mm);
  const day = Number(dd);
  const year = Number(yyyy);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC normalizes rollover values (e.g. 02/31 -> March 3); reject anything that
  // didn't round-trip instead of silently fabricating a different calendar date.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }
  return date.toISOString();
}

/** Stable content hash of a normalized payload, for skip-if-unchanged dedup. */
export function contentHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
