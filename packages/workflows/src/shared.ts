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
export const DAILY_BRIEF_WORKFLOW = "dailyBriefWorkflow";
export const RETENTION_SWEEP_WORKFLOW = "retentionSweepWorkflow";

/** Input to a shortage case workflow: the (possibly merged) detected shortage. */
export interface CaseInput {
  /**
   * The tenant this case belongs to (PHASE6 §6.5). Carried in the workflow INPUT, not looked up
   * inside an activity, because a Temporal workflow has no session and no request: the org is
   * decided once by whoever started the case (the per-org feed poll, or a console action running
   * as a signed-in user) and must then be stable for the case's whole multi-week life. An activity
   * that re-derived it would be free to derive a different answer after a redeploy, and every
   * audit entry it wrote would land in a different hospital's chain.
   *
   * It is also what every activity below passes to `withOrgDb`, so a case started for org A
   * physically cannot read or write org B's rows.
   *
   * REQUIRED, AND THE COMPATIBILITY DECISION IS STATED HERE. Every execution STARTED BEFORE the
   * multi-tenancy deploy has an input in its history with no `orgId` at all. `MAX_MONITORING_MS` is
   * 90 days, so in-flight executions are not an edge case for this workflow — they are its normal
   * state, and a deploy lands in the middle of dozens of them. Making the field required and reading
   * it unconditionally would hand those replays `undefined`, which then fails `withOrgDb`'s uuid
   * guard on EVERY subsequent activity: real running cases, broken by the deploy, at the point a
   * pharmacist next touches them.
   *
   * The type stays REQUIRED — new callers must supply an org, and a missing one must not be
   * expressible in new code — and the old shape is handled at the one place it can be handled
   * deterministically: `resolveCaseOrgId` below, gated on Temporal's `patched()`. Pre-patch history
   * takes `SEED_ORG_ID`, which is not a guess: migration 0013 backfilled every pre-existing row —
   * including the `cases` row each of those executions is tracking — into exactly that org.
   */
  orgId: string;
  record: ShortageRecord;
  /** Feeds that contributed to this shortage (provenance). */
  sources: ShortageRecord["source"][];
}

/**
 * Temporal patch id for the org-qualified `CaseInput` (PHASE6 §6.5).
 *
 * A patch id is part of the workflow's durable history and can never be renamed — `patched(id)`
 * writes a marker under this exact string, and a rename would make every already-marked execution
 * look unpatched again. Declared as a constant so the workflow and its tests name the same one.
 */
export const ORG_QUALIFIED_CASE_INPUT_PATCH = "org-qualified-case-input";

/**
 * The org every pre-multi-tenancy row was backfilled into by migration 0013.
 *
 * DUPLICATED FROM `SEED_ORG_ID` in `packages/db/src/orgs.ts` rather than imported, because this
 * module is bundled into Temporal's deterministic workflow sandbox and `@stopgap/db` pulls in a
 * Postgres driver. `packages/workflows/src/shared.test.ts` asserts the two literals are equal, so
 * the copy cannot drift from the value the migration actually wrote.
 */
export const SEED_ORG_ID = "00000000-0000-0000-0000-0000000000a1";

/**
 * Which org a running case belongs to, correct in BOTH history eras (PHASE6 §6.5).
 *
 * `isPatched` is the result of `patched(ORG_QUALIFIED_CASE_INPUT_PATCH)`, which the workflow
 * evaluates once at the top of its run. It is true for every execution started on or after this
 * deploy (Temporal writes the marker) and false while replaying an execution whose history predates
 * it — so the branch is decided by durable history, not by whether the field happens to be present,
 * and is therefore deterministic across replays.
 *
 * Pre-patch executions fall back to `SEED_ORG_ID`. Post-patch executions read `input.orgId` with NO
 * fallback: after this deploy an input without an org is a bug in the caller, and quietly resolving
 * it to the seed tenant would write one hospital's clinical case into another's chain — far worse
 * than the loud uuid failure `withOrgDb` raises.
 *
 * Pure and exported so the two eras are testable without constructing Temporal histories.
 */
export function resolveCaseOrgId(input: CaseInput, isPatched: boolean): string {
  if (isPatched) return input.orgId;
  // The `??` is not dead code the type system can prove away: this branch exists precisely for
  // deserialized history payloads that predate the field, which arrive as `undefined` at runtime
  // whatever the declared type says.
  return (input.orgId as string | undefined) ?? SEED_ORG_ID;
}

/**
 * Result of the impact assessment activity (Zod-validated, schema owned by @stopgap/agents), plus
 * the one figure the model no longer produces.
 *
 * `affectedFormularyItems` is COUNTED FROM THE CATALOG (ticket 16), not estimated. It sits beside
 * the model's output rather than inside the schema so the boundary is visible in the type: what
 * the model judged, and what the database measured.
 *
 * It is OPTIONAL because the catalog read can fail, and a failed read has not measured zero. The
 * same distinction `NO_CATALOG_DATA` draws on the prompt side is drawn here on the result side:
 * absent means "not counted", and a consumer that wants a number has to decide what to do about
 * not knowing rather than being handed a fabricated 0 it cannot tell from a real one.
 */
export type ImpactResult = ImpactAssessment & { affectedFormularyItems?: number };

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
  /**
   * The alternatives agent's OWN stated confidence in `alternatives` and `draft`, 0 to 1.
   *
   * Surfaced because a pharmacist deciding on generated text needs the model's own hedge in front
   * of them, not only the routing outcome it produced. Absent when the protocol came from
   * organizational memory or from a pharmacist resolving an exception — neither is a model
   * estimate, and reusing the field for them would misreport a human decision as a model's.
   */
  researchConfidence?: number;
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
  /** The tenant whose protocol store this version belongs to (PHASE6 §6.5). */
  orgId: string;
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
