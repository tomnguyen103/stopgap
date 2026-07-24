import type { CaseStatus, Severity, ShortageRecord } from "@stopgap/core";
import type { AlternativesResearch, ImpactAssessment } from "@stopgap/agents";

/**
 * Workflow type names as literal strings.
 *
 * Starting a workflow by passing the imported function makes Temporal read `fn.name` — which
 * a production bundler is free to mangle. It did: the console's `next build` minified
 * `shortageCaseWorkflow` to `aa`, so every case started from the deployed console died with
 * "no such function is exported by the workflow bundle" while the same code worked in dev.
 * Callers use these constants; the worker still registers the real exports.
 */
export const SHORTAGE_CASE_WORKFLOW = "shortageCaseWorkflow";
export const POLL_FEEDS_WORKFLOW = "pollFeedsWorkflow";
export const ANCHOR_AUDIT_WORKFLOW = "anchorAuditWorkflow";

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

/**
 * A pharmacist's HITL decision on the drafted protocol. `reviewer` is a CLAIMED identity —
 * signals are unauthenticated, so the audit trail records who the caller said they were, never
 * an asserted-verified principal (see PHASE5-TODO for the auth work).
 */
export type ReviewDecision = {
  reviewer?: string;
  /**
   * The authenticated reviewer's `users.id` (PHASE6 §6.1), threaded from the console session so
   * the audit chain records a machine-checkable principal beside the `reviewer` label. Optional
   * because the CLI/MCP callers still sign with only a claimed label.
   */
  reviewerUserId?: string;
} & ({ kind: "approve" } | { kind: "edit"; editedDraft: string } | { kind: "reject"; reason: string });

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
  /** Whether any comms channel actually delivered — `comms_sent` only means "we tried". */
  commsDelivered?: boolean;
  /**
   * Escalation ladder state (PHASE6 §6.3), driving the console's per-case timeline.
   * `escalationStep` is the highest ladder tier reached so far (0-based); `escalationEvents` is one
   * record per tier attempted, so the timeline reads "notified → escalated → …". `acked`/`ackedBy`
   * flip when a human acknowledges via the `acknowledgeCase` signal. Absent `escalationStep` means
   * the ladder never ran (severity below high, or no policy configured).
   *
   * Each event carries its OWN tier rather than relying on array position: a tier whose send
   * failed still occupies a slot, so position and tier index diverge the moment one does.
   */
  escalationStep?: number;
  escalationEvents: EscalationEvent[];
  acked: boolean;
  /** The acknowledging user's `users.id` (never a claimed string). */
  ackedBy?: string;
  /**
   * Why the last acknowledgment failed to persist. Set when `recordAck` exhausted its retries, at
   * which point `acked` rolls back to false: an ack with no `acknowledgments` row and no
   * `case.acknowledged` audit entry did not happen, and the case is still unacknowledged.
   */
  ackError?: string;
}

/**
 * One attempted escalation tier. `sendFailed` marks a tier whose notification activity REJECTED
 * outright (its own non-delivery write failed, say): the ladder keeps climbing past it, and
 * without this record the tier would vanish while progress looked normal — the faked success this
 * codebase refuses. A tier that merely resolved `delivered: false` is NOT flagged here; the
 * activity already recorded that honestly in the audit chain.
 */
export interface EscalationEvent {
  step: number;
  at: string;
  sendFailed: boolean;
}

/**
 * A human acknowledgment of an escalating case (PHASE6 §6.3), carried by the `acknowledgeCase`
 * signal from the console server action. `userId` is the authenticated `users.id`; `label` is the
 * human-readable actor for the audit chain's text field. The tier is NOT carried here: the
 * workflow derives it from its own escalation state, so a caller cannot record an ack against a
 * tier that was never reached.
 */
export interface CaseAcknowledgment {
  userId: string;
  label: string;
}

/** One escalation ladder tier: page `notify` `afterMinutes` after escalation started. */
export interface EscalationStep {
  afterMinutes: number;
  notify: string;
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
  /** Authenticated author/approver `users.id`s (PHASE6 §6.1), beside the free-text labels. */
  authoredByUserId?: string;
  approvedByUserId?: string;
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
  /** Authenticated resolver's `users.id` (PHASE6 §6.1), beside the `resolvedBy` label. */
  resolvedByUserId?: string;
  /** Why — becomes the version's rationale, so the rule carries its reason forever. */
  rationale: string;
}
