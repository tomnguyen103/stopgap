import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";
// Deliberately imported from the isolated `/schemas` subpath, not the package root: the
// root barrel also exports the agent functions (network calls, provider SDKs), which must
// never enter Temporal's deterministic workflow sandbox. This subpath is pure Zod + a
// constant, safe to bundle here.
import { CONFIDENCE_THRESHOLD } from "@stopgap/agents/schemas";
import type * as activities from "./activities.js";
import {
  MAX_MONITORING_MS,
  MONITOR_POLL_MS,
  type CaseInput,
  type CaseState,
  type ExceptionResolution,
  type ReviewDecision,
} from "./shared.js";

/**
 * The durable spine of Stopgap (ADR-0002, PROJECT_PLAN §3C). One workflow per shortage
 * case; it owns every status transition, survives worker restarts and deploys, and blocks
 * for weeks on a pharmacist signal or feed resolution. LLM judgment lives only in activities.
 */

const acts = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5, initialInterval: "1s", backoffCoefficient: 2 },
});

/** Pharmacist approve/edit/reject on the drafted protocol. */
export const reviewSignal = defineSignal<[ReviewDecision]>("review");
/** Feed marked the shortage resolved → begin reversion. */
export const resolvedSignal = defineSignal("resolved");
/**
 * A pharmacist resolved an exception-queue case. The resolution becomes an approved protocol
 * version (organizational memory) and the case continues from where it parked, rather than
 * dying in the queue — this is the "exceptions write the SOP" loop (PROJECT_PLAN §3B).
 */
export const exceptionResolvedSignal = defineSignal<[ExceptionResolution]>("exceptionResolved");
/** Queryable case snapshot (drives the console + tests). */
export const stateQuery = defineQuery<CaseState>("state");

export async function shortageCaseWorkflow(input: CaseInput): Promise<CaseState> {
  const key = input.record.key;
  const state: CaseState = {
    status: "detected",
    alternatives: [],
    monitoringWeeks: 0,
    resolved: false,
  };
  setHandler(stateQuery, () => state);

  let decision: ReviewDecision | undefined;
  setHandler(reviewSignal, (d) => {
    decision = d;
  });
  setHandler(resolvedSignal, () => {
    state.resolved = true;
  });
  let exceptionResolution: ExceptionResolution | undefined;
  setHandler(exceptionResolvedSignal, (resolution) => {
    exceptionResolution = resolution;
  });

  /**
   * Park the case in the exception queue and wait for a pharmacist. A resolution becomes an
   * approved protocol version (memory) and lets the case continue; no resolution within the
   * monitoring horizon leaves the case in `exception`, exactly as before this loop existed.
   */
  async function parkInException(reason: string, detail: Record<string, unknown>): Promise<boolean> {
    state.status = "exception";
    state.exceptionReason = reason;
    await acts.persistStatus(key, "exception", { reason, ...detail });
    const resolved = await condition(() => exceptionResolution !== undefined, MAX_MONITORING_MS);
    if (!resolved) return false;
    const resolution = exceptionResolution!;
    state.draft = resolution.protocolBody;
    state.alternatives = resolution.alternatives;
    state.protocolSource = "exception-resolution";
    await acts.recordProtocolVersion({
      key,
      title: input.record.genericName,
      body: resolution.protocolBody,
      alternatives: resolution.alternatives,
      authoredBy: resolution.resolvedBy,
      approvedBy: resolution.resolvedBy,
      rationale: resolution.rationale,
    });
    return true;
  }

  await acts.recordDetected(input);

  // Assess impact.
  state.status = "assessing";
  await acts.persistStatus(key, "assessing");
  const impact = await acts.assessImpact(input);
  state.severity = impact.severity;

  // A shaky severity call is as dangerous as a shaky substitution — don't spend a research
  // call building on an assessment the agent itself isn't confident in (§8 under-escalation
  // target ≈ 0).
  if (impact.confidence < CONFIDENCE_THRESHOLD) {
    const resolved = await parkInException("low-confidence-impact", {
      confidence: impact.confidence,
      severity: impact.severity,
    });
    if (!resolved) return state;
  } else {
    // Organizational memory first (PROJECT_PLAN §3B/§4): if a pharmacist already approved
    // substitution guidance for this drug, reuse it instead of paying for a research call
    // and asking a human to re-approve text they wrote themselves. The HITL gate still runs
    // — memory changes how much work happens before the pharmacist looks, never whether.
    state.status = "researching";
    await acts.persistStatus(key, "researching", { severity: impact.severity });
    const remembered = await acts.lookupProtocol(key);
    if (remembered) {
      state.alternatives = remembered.alternatives;
      state.draft = remembered.body;
      state.protocolSource = "memory";
      state.protocolVersion = remembered.version;
    } else {
      const research = await acts.researchAlternatives(input);
      state.alternatives = research.alternatives;
      state.draft = research.draft;
      state.protocolSource = "agent";

      // No therapeutic equivalent, no draft text, or the agent isn't confident enough to
      // auto-draft → exception queue (always human; PROJECT_PLAN §2 exception matrix, §8
      // under-escalation target ≈ 0). A missing draft with alternatives present would
      // otherwise reach the HITL review with nothing to approve/edit/reject.
      const missingDraft = research.draft.trim().length === 0;
      if (
        research.alternatives.length === 0 ||
        missingDraft ||
        research.confidence < CONFIDENCE_THRESHOLD
      ) {
        const resolved = await parkInException(
          research.alternatives.length === 0
            ? "no-therapeutic-equivalent"
            : missingDraft
              ? "missing-protocol-draft"
              : "low-confidence-alternatives",
          { confidence: research.confidence },
        );
        if (!resolved) return state;
      }
    }
  }

  // Draft ready → HITL gate. Skipped only when a pharmacist personally resolved the
  // exception: the draft IS their text, already approved, so re-asking them to approve it
  // would be ceremony, not review.
  if (state.protocolSource !== "exception-resolution") {
    state.status = "protocol_draft";
    await acts.persistStatus(key, "protocol_draft");
    state.status = "awaiting_review";
    await acts.persistStatus(key, "awaiting_review");

    // Block (possibly for days) until the pharmacist decides.
    await condition(() => decision !== undefined);
    state.decision = decision;
    await acts.recordDecision(key, decision!);
    if (decision!.kind === "reject") {
      state.status = "rejected";
      await acts.persistStatus(key, "rejected", { reason: decision!.reason });
      return state;
    }
    if (decision!.kind === "edit") state.draft = decision!.editedDraft;

    // Approved text the memory doesn't already hold becomes a new protocol version — an
    // agent draft a human signed off on, or a human's edit of one. Reusing a remembered
    // protocol unchanged writes nothing: it would be a duplicate version with no new content.
    if (state.protocolSource === "agent" || decision!.kind === "edit") {
      await acts.recordProtocolVersion({
        key,
        title: input.record.genericName,
        body: state.draft ?? "",
        alternatives: state.alternatives,
        authoredBy: decision!.kind === "edit" ? (decision!.reviewer ?? "unknown-reviewer") : "agent",
        approvedBy: decision!.reviewer ?? "unknown-reviewer",
        rationale:
          decision!.kind === "edit"
            ? "Pharmacist edit of the agent draft at review."
            : "Agent draft approved unchanged at review.",
      });
    }
  }

  // Approved → comms out.
  state.status = "approved";
  await acts.persistStatus(key, "approved");
  const comms = await acts.sendComms(key, state.draft ?? "", state.alternatives);
  state.status = "comms_sent";
  state.commsDelivered = comms.delivered;
  await acts.persistStatus(key, "comms_sent", { delivered: comms.delivered });

  // Monitor until the feed resolves the shortage — the long-horizon leg (weeks–months).
  // Ticks weekly (durable across worker restarts/deploys) so monitoringWeeks reflects real
  // elapsed time; auto-escalates to exception if unresolved past MAX_MONITORING_MS total.
  state.status = "monitoring";
  await acts.persistStatus(key, "monitoring");
  const monitorStart = Date.now();
  while (!state.resolved) {
    const remaining = MAX_MONITORING_MS - (Date.now() - monitorStart);
    if (remaining <= 0) break;
    const waitMs = Math.min(MONITOR_POLL_MS, remaining);
    const resolvedInTime = await condition(() => state.resolved, waitMs);
    if (resolvedInTime) break;
    // Only a full week's wait counts as a week — the last tick before MAX_MONITORING_MS may
    // be a shortened remainder, and that shouldn't round up to a full monitoringWeeks tick.
    if (waitMs === MONITOR_POLL_MS) {
      state.monitoringWeeks += 1;
      await acts.persistStatus(key, "monitoring", { monitoringWeeks: state.monitoringWeeks });
    }
  }
  const deadlineHit = !state.resolved;
  if (deadlineHit) {
    state.status = "exception";
    await acts.persistStatus(key, "exception", { reason: "monitoring-timeout" });
    return state;
  }

  // Resolved → draft reversion, then close.
  state.status = "reverting";
  await acts.persistStatus(key, "reverting");
  state.status = "closed";
  await acts.persistStatus(key, "closed");
  return state;
}

/**
 * The feed-poll workflow (PROJECT_PLAN §4: "poll → new shortage auto-opens a case"). One
 * run = one poll of openFDA + ASHP; a Temporal Schedule (`scripts/start-schedule.ts`) fires
 * it on a cadence so new shortages open cases without a human running `start-case` by hand.
 */
export async function pollFeedsWorkflow(): Promise<{ polled: number; opened: number }> {
  return acts.pollAndOpenCases();
}
