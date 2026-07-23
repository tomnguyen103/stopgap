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
  /** Where the protocol text came from — drives the "reused v3" badge in the console. */
  protocolSource?: "agent" | "memory" | "exception-resolution";
  /** Protocol version reused from memory, when `protocolSource` is "memory". */
  protocolVersion?: number;
  /** Why the case parked in the exception queue, if it did. */
  exceptionReason?: string;
}

/** Max time a case may sit unresolved before it auto-escalates to the exception queue. */
export const MAX_MONITORING = "90 days";
export const MAX_MONITORING_MS = 90 * 24 * 60 * 60 * 1000;
/** Cadence at which a monitoring case re-checks the feed for resolution. */
export const MONITOR_POLL = "7 days";
export const MONITOR_POLL_MS = 7 * 24 * 60 * 60 * 1000;

/** An approved protocol found in organizational memory for this shortage key. */
export interface ProtocolMemoryHit {
  versionId: string;
  version: number;
  body: string;
  alternatives: string[];
}

/** Input for writing a case's approved outcome back into the protocol store. */
export interface RecordProtocolInput {
  key: string;
  title: string;
  body: string;
  alternatives: string[];
  /** "agent" when the draft came from the research agent, else the pharmacist id. */
  authoredBy: string;
  approvedBy: string;
  rationale?: string;
}

/**
 * A pharmacist's resolution of an exception case (PROJECT_PLAN §3B: "approved exception
 * resolutions become rules"). Signalling this un-blocks a case parked in the exception queue
 * and writes the resolution into the protocol store as a new approved version.
 */
export interface ExceptionResolution {
  /** The substitution guidance the pharmacist decided on. */
  protocolBody: string;
  alternatives: string[];
  resolvedBy: string;
  /** Why — becomes the version's rationale, so the rule carries its reason forever. */
  rationale: string;
}
