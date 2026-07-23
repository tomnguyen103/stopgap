import type { CaseStatus, Severity, ShortageRecord } from "@stopgap/core";
import type { AlternativesResearch, ImpactAssessment } from "@stopgap/agents";

/** Input to a shortage case workflow: the (possibly merged) detected shortage. */
export interface CaseInput {
  record: ShortageRecord;
  /** Feeds that contributed to this shortage (provenance). */
  sources: ShortageRecord["source"][];
}

/** Result of the impact assessment activity (Zod-validated, schema owned by @stopgap/agents). */
export type ImpactResult = ImpactAssessment;

/** Result of the alternatives research activity (Zod-validated, schema owned by @stopgap/agents). */
export type ResearchResult = AlternativesResearch;

/** A pharmacist's HITL decision on the drafted protocol. */
export type ReviewDecision =
  | { kind: "approve" }
  | { kind: "edit"; editedDraft: string }
  | { kind: "reject"; reason: string };

/** Queryable snapshot of a running case (drives the console). */
export interface CaseState {
  status: CaseStatus;
  severity?: Severity;
  alternatives: string[];
  draft?: string;
  decision?: ReviewDecision;
  /** Weeks the case has spent in monitoring (proves long-horizon durability). */
  monitoringWeeks: number;
  resolved: boolean;
}

/** Max time a case may sit unresolved before it auto-escalates to the exception queue. */
export const MAX_MONITORING = "90 days";
export const MAX_MONITORING_MS = 90 * 24 * 60 * 60 * 1000;
/** Cadence at which a monitoring case re-checks the feed for resolution. */
export const MONITOR_POLL = "7 days";
export const MONITOR_POLL_MS = 7 * 24 * 60 * 60 * 1000;
