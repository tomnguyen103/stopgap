import type { CaseStatus, Severity, ShortageRecord } from "@stopgap/core";

/** Input to a shortage case workflow: the (possibly merged) detected shortage. */
export interface CaseInput {
  record: ShortageRecord;
  /** Feeds that contributed to this shortage (provenance). */
  sources: ShortageRecord["source"][];
}

/** Result of the (Phase 1 mocked) impact assessment activity. */
export interface ImpactResult {
  severity: Severity;
  /** How many formulary items the shortage touches (mock inventory match). */
  affectedFormularyItems: number;
  rationale: string;
}

/** Result of the (Phase 1 mocked) alternatives research activity. */
export interface ResearchResult {
  /** Candidate substitute drug names. Empty ⇒ no therapeutic equivalent (exception path). */
  alternatives: string[];
  /** Draft substitution protocol text. */
  draft: string;
}

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
/** Cadence at which a monitoring case re-checks the feed for resolution. */
export const MONITOR_POLL = "7 days";
