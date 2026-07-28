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
  if (
    s.includes("current") ||
    s.includes("active") ||
    s.includes("discontinu") ||
    s.includes("shortage")
  )
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
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return date.toISOString();
}

/**
 * Parse openFDA's enforcement-endpoint `YYYYMMDD` date to an ISO 8601 string.
 *
 * A DIFFERENT format from `parseUsDate` above, from the same provider: the shortage endpoint emits
 * `MM/DD/YYYY` and the enforcement endpoint emits `YYYYMMDD`. Kept as two explicit parsers rather
 * than one permissive one, so a feed that changes format fails visibly instead of guessing.
 */
export function parseCompactDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim());
  if (!m) return undefined;
  const [, yyyy, mm, dd] = m;
  const year = Number(yyyy);
  const month = Number(mm);
  const day = Number(dd);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return date.toISOString();
}

/** Distinct values, order preserved. */
export function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/**
 * Distinct non-blank strings, TRIMMED, for identifier and name lists that arrive with gaps in them.
 *
 * Trimming before the distinct pass, not after: feeds pad values inconsistently, so `" ABC "` and
 * `"ABC"` are one identifier that would otherwise survive as two. Two spellings of one NDC means a
 * catalog match that hits on one poll and misses on the next.
 */
export function uniqueNonBlank(xs: (string | undefined)[]): string[] {
  return unique(
    xs
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim())
      .filter((x) => x.length > 0),
  );
}

/** Stable content hash of a normalized payload, for skip-if-unchanged dedup. */
export function contentHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
