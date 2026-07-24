import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
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

/**
 * Run an agent activity and turn an exhausted-retry failure into a value instead of an
 * exception. The agent layer is the one dependency that can be down for minutes (provider
 * outage, model not pulled yet) rather than milliseconds, and an escaping activity failure
 * fails the whole workflow — leaving a real shortage case frozen mid-assessment with nobody
 * notified. Callers park those cases in the exception queue, which is where "the machine
 * could not decide this" belongs.
 *
 * Deliberately not a catch-all: this wraps only the two LLM activities. A failure in a
 * database write is a bug, and swallowing it would hide it.
 */
async function callAgent<T>(
  run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

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
  async function parkInException(
    reason: string,
    detail: Record<string, unknown>,
  ): Promise<boolean> {
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
  const impact = await callAgent(() => acts.assessImpact(input));
  if (!impact.ok) {
    // The agent layer is down (provider outage, exhausted retries). Letting the activity
    // failure escape would fail the workflow and strand the case mid-assessment with nobody
    // told — a dropped case, the one number PROJECT_PLAN §14 puts at zero. Park it for a
    // human instead: the exception queue is exactly the place for "the machine could not
    // decide this".
    const resolved = await parkInException("agent-unavailable", {
      step: "assessImpact",
      error: impact.error,
    });
    if (!resolved) return state;
  } else if (impact.value.confidence < CONFIDENCE_THRESHOLD) {
    state.severity = impact.value.severity;
    const resolved = await parkInException("low-confidence-impact", {
      confidence: impact.value.confidence,
      severity: impact.value.severity,
    });
    if (!resolved) return state;
  } else {
    state.severity = impact.value.severity;
    // Organizational memory first (PROJECT_PLAN §3B/§4): if a pharmacist already approved
    // substitution guidance for this drug, reuse it instead of paying for a research call
    // and asking a human to re-approve text they wrote themselves. The HITL gate still runs
    // — memory changes how much work happens before the pharmacist looks, never whether.
    state.status = "researching";
    await acts.persistStatus(key, "researching", { severity: impact.value.severity });
    const remembered = await acts.lookupProtocol(key);
    if (remembered) {
      state.alternatives = remembered.alternatives;
      state.draft = remembered.body;
      state.protocolSource = "memory";
      state.protocolVersion = remembered.version;
    } else {
      const researched = await callAgent(() => acts.researchAlternatives(input));
      if (!researched.ok) {
        // Same reasoning as the assessment step: an agent outage becomes a human decision,
        // never a workflow that dies with the case still open.
        const resolved = await parkInException("agent-unavailable", {
          step: "researchAlternatives",
          error: researched.error,
        });
        if (!resolved) return state;
        // Resolved: the pharmacist's text is the protocol, and the HITL block below skips
        // exception-resolution cases, so nothing further in this branch applies.
      } else {
        const research = researched.value;
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
        authoredBy:
          decision!.kind === "edit" ? (decision!.reviewer ?? "unknown-reviewer") : "agent",
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
