import { z } from "zod";

/**
 * Domain model shared across ingest, workflows, db, and console.
 * Zod is the source of truth; TS types are inferred from schemas.
 */

/** Source feed a shortage record came from. */
export const FeedSource = z.enum(["openfda", "ashp"]);
export type FeedSource = z.infer<typeof FeedSource>;

/** Normalized shortage status across heterogeneous feeds. */
export const ShortageStatus = z.enum(["current", "resolved", "unknown"]);
export type ShortageStatus = z.infer<typeof ShortageStatus>;

/**
 * A normalized shortage record. Feed-specific payloads are mapped into this shape by
 * `@stopgap/ingest`. `sourceId` + `source` uniquely identify a feed record; `key` is the
 * cross-feed dedup key (normalized generic name).
 */
export const ShortageRecord = z.object({
  source: FeedSource,
  /** Stable id within the source feed (e.g. openFDA record id or ASHP slug). */
  sourceId: z.string().min(1),
  /** Cross-feed dedup key: lowercased, trimmed generic drug name. */
  key: z.string().min(1),
  genericName: z.string().min(1),
  status: ShortageStatus,
  /** NDC package codes affected, when the feed provides them. */
  ndcs: z.array(z.string()).default([]),
  /** Free-text availability / reason as reported by the feed. */
  note: z.string().optional(),
  /** When the feed last updated this record (ISO 8601), if known. */
  updatedAt: z.string().datetime().optional(),
  /** Raw feed payload, retained for provenance/audit. */
  raw: z.unknown().optional(),
});
export type ShortageRecord = z.infer<typeof ShortageRecord>;

/**
 * Lifecycle of a durable shortage case (Temporal workflow state, mirrored to Postgres).
 * The workflow — not the model — owns these transitions (ADR-0002).
 */
export const CaseStatus = z.enum([
  "detected",
  "assessing",
  "researching",
  "protocol_draft",
  "awaiting_review",
  "approved",
  "rejected",
  "comms_sent",
  "monitoring",
  "reverting",
  "closed",
  "exception",
]);
export type CaseStatus = z.infer<typeof CaseStatus>;

/** Severity of the impact assessment. */
export const Severity = z.enum(["none", "low", "moderate", "high", "critical"]);
export type Severity = z.infer<typeof Severity>;

export const TERMINAL_CASE_STATUSES: readonly CaseStatus[] = ["closed", "rejected"];

export function isTerminalStatus(s: CaseStatus): boolean {
  return TERMINAL_CASE_STATUSES.includes(s);
}
