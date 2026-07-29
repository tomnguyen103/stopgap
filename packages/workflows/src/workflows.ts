import {
  condition,
  defineQuery,
  defineSignal,
  patched,
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
  ORG_QUALIFIED_CASE_INPUT_PATCH,
  resolveCaseOrgId,
  type CaseAcknowledgment,
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
 * The brief's own proxy (ticket 13). One activity call does ONE MODEL CALL PER TENANT in sequence,
 * so its runtime scales with the registry while every other activity here is a single bounded
 * operation. Under the shared one-minute timeout the brief would start timing out as soon as the
 * deployment had more than a handful of organizations, and each retry would re-spend the model
 * budget for every tenant already written. Retries are capped at two for the same reason: a
 * provider outage is already absorbed inside the activity as a degraded brief, so an exhausted
 * retry here means something structural, and repeating it costs money without changing the answer.
 */
const briefActs = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 minutes",
  // The activity heartbeats per tenant and on both sides of each model call, so a worker that dies
  // mid-run is detected in minutes instead of at the 30-minute start-to-close bound. The window is
  // wide enough for one provider call to run long without being mistaken for a dead worker.
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 2, initialInterval: "10s", backoffCoefficient: 2 },
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
/**
 * A human acknowledged an escalating case (PHASE6 §6.3). Carries the authenticated `users.id`, a
 * label for the audit chain's text field, and optionally the tier the ack answers. The first ack
 * wins and stops the ladder; the escalation loop records it (DB + audit) — a signal handler must
 * stay synchronous, so it only sets flags here.
 */
export const acknowledgeSignal = defineSignal<[CaseAcknowledgment]>("acknowledgeCase");
/** Queryable case snapshot (drives the console + tests). */
export const stateQuery = defineQuery<CaseState>("state");

export async function shortageCaseWorkflow(input: CaseInput): Promise<CaseState> {
  const key = input.record.key;
  // The tenant this case belongs to, fixed at start time and passed to every activity (PHASE6
  // §6.5). A workflow has no session to derive it from, and deriving it inside an activity would
  // let it change across a case's multi-week life — week 6's audit entry landing in a different
  // hospital's chain from week 1's. Carried in the input, it cannot.
  //
  // `patched()` is evaluated FIRST and unconditionally, before any signal handler or activity, so
  // the marker lands at the same point in every execution's history. It distinguishes the two eras
  // of this workflow's input: executions started before multi-tenancy carry no `orgId` at all, and
  // with `MAX_MONITORING_MS` at 90 days there are always some of those in flight when a deploy
  // lands. `resolveCaseOrgId` documents which value each era gets and why.
  const orgId = resolveCaseOrgId(input, patched(ORG_QUALIFIED_CASE_INPUT_PATCH));
  // The input as the activities see it. `recordDetected` reads `input.orgId` directly (it is the
  // activity that CREATES the case row), so handing it the raw pre-patch input would scope it to
  // `undefined` — the resolved org has to travel with the payload, not just in this closure.
  const caseInput: CaseInput = { ...input, orgId };
  const state: CaseState = {
    status: "detected",
    alternatives: [],
    monitoringWeeks: 0,
    resolved: false,
    escalationEvents: [],
    acked: false,
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

  // ---- Escalation ladder (PHASE6 §6.3) ---------------------------------------------------
  // Runs CONCURRENTLY with the case's own flow (HITL, monitoring): a critical shortage pages the
  // pharmacist immediately and climbs the ladder if nobody acks, independent of whether the draft
  // is still under review. Detached on purpose — the main workflow never awaits it, so when the
  // case reaches a terminal state the outstanding ladder timer is simply cancelled at completion.
  // The durable Temporal timer between tiers is the whole point: it survives a worker restart, so
  // an escalation fires on schedule even if the process that scheduled it has since died.
  let pendingAck: { userId: string; label: string; step: number } | undefined;
  let escalationStarted = false;
  /** Set once `recordAck` has COMMITTED. The ladder stops for a durable ack, never a pending one. */
  let ackPersisted = false;
  setHandler(acknowledgeSignal, (ack) => {
    // Nothing to acknowledge until the ladder is running. Without this an early signal would set
    // `state.acked` and a later critical/high case would exit the ladder before tier 0 ever paged
    // anyone — an ack for a page that never happened.
    if (!escalationStarted) return;
    if (state.acked) return; // first ack wins; a second is a no-op, not a second row.
    state.acked = true;
    state.ackedBy = ack.userId;
    // Hand the ack to the durable recorder below; the handler itself stays side-effect-free (no
    // activities). The tier comes from WORKFLOW state, not the payload: the caller cannot record
    // an ack against a tier that was never reached. `escalationStep` is the highest tier fired so
    // far, so a post-exhaustion ack pins the final tier, and an ack before tier 0 fires pins 0.
    pendingAck = { userId: ack.userId, label: ack.label, step: state.escalationStep ?? 0 };
  });

  /**
   * Persist an acknowledgment durably (the `acknowledgments` row + a `case.acknowledged` audit
   * entry with the authenticated user id) for as long as the case is alive. Runs ALONGSIDE the
   * escalation ladder and OUTLIVES it, so an ack that arrives AFTER every tier has fired is still
   * written — the ladder loop alone returns once exhausted and would miss it, leaving the case
   * flagged critical-unacked forever. One ack per case (the handler guards on `state.acked`), so
   * this waits once and records once. `recordAck` is idempotent on (case, step), so a retry after a
   * committed insert is a no-op.
   */
  async function runAckRecorder(): Promise<void> {
    for (;;) {
      await condition(() => pendingAck !== undefined);
      const ack = pendingAck!;
      try {
        await acts.recordAck({ orgId, key, userId: ack.userId, label: ack.label, step: ack.step });
        state.ackError = undefined;
        ackPersisted = true;
        return;
      } catch (err) {
        // Persistence gave up after every activity retry: the `acknowledgments` row and the
        // `case.acknowledged` audit entry do not exist, so the case is NOT acknowledged. Roll the
        // flag back rather than leave the console and ops-metrics asserting an ack with no durable
        // record — an unacknowledged critical case must keep showing as one — and wait for another
        // ack, which the cleared `acked` flag now lets the signal handler accept.
        state.acked = false;
        state.ackedBy = undefined;
        state.ackError = err instanceof Error ? err.message : String(err);
        pendingAck = undefined;
      }
    }
  }

  async function runEscalationLadder(severity: string): Promise<void> {
    const policy = await acts.getEscalationPolicy(severity);
    if (!policy || policy.steps.length === 0) return;
    let elapsedMin = 0;
    for (let i = 0; i < policy.steps.length; i += 1) {
      const step = policy.steps[i]!;
      const waitMin = step.afterMinutes - elapsedMin;
      // Wait out this tier's delay, cut short the moment a human acks. `condition` returns true on
      // ack (stop the ladder), false on timeout (fire this tier).
      if (waitMin > 0) await condition(() => state.acked, waitMin * 60_000);
      if (state.acked) {
        // An ack stops the ladder only once it is DURABLE. While the recorder is still retrying,
        // hold here rather than page — but if persistence ultimately fails, the recorder rolls
        // `acked` back and the ladder must RESUME, or a failed write would silently bury the
        // director and admin tiers for a case nobody has actually acknowledged.
        await condition(() => ackPersisted || !state.acked);
        if (ackPersisted) return;
      }
      // A failed send records non-delivery inside the activity and STILL advances the ladder —
      // the existing comms stance: "we tried to page the director" must be falsifiable, and a
      // channel being down cannot pin escalation at one tier forever. The try/catch contains a
      // tier whose activity REJECTS (its own non-delivery write failed, say) to that tier: without
      // it the rejection unwinds the whole ladder and the remaining tiers — director, admin — are
      // silently never paged.
      try {
        await acts.sendEscalationNotification({
          orgId,
          key,
          severity,
          stepIndex: i,
          notify: step.notify,
          afterMinutes: step.afterMinutes,
        });
        state.escalationEvents = [
          ...state.escalationEvents,
          { step: i, at: new Date().toISOString(), sendFailed: false },
        ];
      } catch {
        // Keep climbing — the next tier is a different audience and may well be reachable — but
        // RECORD the skipped tier rather than claiming it was notified. A rejecting activity wrote
        // no non-delivery row and bumped no counter, so presenting it as a page would be exactly
        // the faked success this codebase refuses.
        state.escalationEvents = [
          ...state.escalationEvents,
          { step: i, at: new Date().toISOString(), sendFailed: true },
        ];
      }
      state.escalationStep = i;
      elapsedMin = step.afterMinutes;
    }
    // Ladder exhausted with no ack: stop at "escalated/unacked" (the case is NOT failed — everyone
    // in the ladder has now been paged). The detached promise resolves here, leaving no pending
    // work so a worker can shut down cleanly. An ack that arrives after full escalation is a no-op
    // for the ladder; the console's timeline still shows the case as escalated-unacked.
  }

  /**
   * Kick off the ladder once severity is known and warrants it (critical/high). Detached with a
   * swallowed rejection: escalation is best-effort auxiliary work, so a policy-read failure must
   * never fail the clinical case itself (its own activities already record non-delivery honestly).
   */
  function startEscalationIfNeeded(): void {
    if (escalationStarted) return;
    const severity = state.severity;
    if (severity !== "critical" && severity !== "high") return;
    escalationStarted = true;
    void runEscalationLadder(severity).catch(() => {});
    // Durable ack-recorder, started ALONGSIDE the ladder and outliving it: a post-exhaustion ack
    // (after every tier fired) must still write the row + audit entry, which the ladder alone would
    // miss — otherwise ops-metrics keeps counting the case critical-unacked forever.
    void runAckRecorder().catch(() => {});
  }

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
    await acts.persistStatus(orgId, key, "exception", { reason, ...detail });
    const resolved = await condition(() => exceptionResolution !== undefined, MAX_MONITORING_MS);
    if (!resolved) return false;
    const resolution = exceptionResolution!;
    state.draft = resolution.protocolBody;
    state.alternatives = resolution.alternatives;
    state.protocolSource = "exception-resolution";
    await acts.recordProtocolVersion({
      orgId,
      key,
      title: input.record.genericName,
      body: resolution.protocolBody,
      alternatives: resolution.alternatives,
      authoredBy: resolution.resolvedBy,
      approvedBy: resolution.resolvedBy,
      authoredByUserId: resolution.resolvedByUserId,
      approvedByUserId: resolution.resolvedByUserId,
      rationale: resolution.rationale,
    });
    return true;
  }

  await acts.recordDetected(caseInput);

  // Assess impact.
  state.status = "assessing";
  await acts.persistStatus(orgId, key, "assessing");
  const impact = await callAgent(() => acts.assessImpact(caseInput));
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
    // A low-confidence assessment still carries a severity, and a critical one parked for a human
    // is exactly when the ladder matters most — start it BEFORE parking, which blocks for days.
    startEscalationIfNeeded();
    const resolved = await parkInException("low-confidence-impact", {
      confidence: impact.value.confidence,
      severity: impact.value.severity,
    });
    if (!resolved) return state;
  } else {
    state.severity = impact.value.severity;
    // Severity is known → the ladder can begin, concurrently with research/HITL below.
    startEscalationIfNeeded();
    // Organizational memory first (PROJECT_PLAN §3B/§4): if a pharmacist already approved
    // substitution guidance for this drug, reuse it instead of paying for a research call
    // and asking a human to re-approve text they wrote themselves. The HITL gate still runs
    // — memory changes how much work happens before the pharmacist looks, never whether.
    state.status = "researching";
    await acts.persistStatus(orgId, key, "researching", { severity: impact.value.severity });
    const remembered = await acts.lookupProtocol(orgId, key);
    if (remembered) {
      state.alternatives = remembered.alternatives;
      state.draft = remembered.body;
      state.protocolSource = "memory";
      state.protocolVersion = remembered.version;
    } else {
      const researched = await callAgent(() => acts.researchAlternatives(caseInput));
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
    await acts.persistStatus(orgId, key, "protocol_draft");
    state.status = "awaiting_review";
    await acts.persistStatus(orgId, key, "awaiting_review");

    // Block (possibly for days) until the pharmacist decides.
    await condition(() => decision !== undefined);
    state.decision = decision;
    await acts.recordDecision(orgId, key, decision!);
    if (decision!.kind === "reject") {
      state.status = "rejected";
      await acts.persistStatus(orgId, key, "rejected", { reason: decision!.reason });
      return state;
    }
    if (decision!.kind === "edit") state.draft = decision!.editedDraft;

    // Approved text the memory doesn't already hold becomes a new protocol version — an
    // agent draft a human signed off on, or a human's edit of one. Reusing a remembered
    // protocol unchanged writes nothing: it would be a duplicate version with no new content.
    if (state.protocolSource === "agent" || decision!.kind === "edit") {
      await acts.recordProtocolVersion({
        orgId,
        key,
        title: input.record.genericName,
        body: state.draft ?? "",
        alternatives: state.alternatives,
        authoredBy:
          decision!.kind === "edit" ? (decision!.reviewer ?? "unknown-reviewer") : "agent",
        approvedBy: decision!.reviewer ?? "unknown-reviewer",
        // A human edit is authored by the reviewer; an approved agent draft stays "agent"
        // (the activity maps that label to the synthetic agent user). Either way the approver
        // is the authenticated reviewer whose `users.id` the console threaded through the signal.
        authoredByUserId: decision!.kind === "edit" ? decision!.reviewerUserId : undefined,
        approvedByUserId: decision!.reviewerUserId,
        rationale:
          decision!.kind === "edit"
            ? "Pharmacist edit of the agent draft at review."
            : "Agent draft approved unchanged at review.",
      });
    }
  }

  // Approved → comms out.
  state.status = "approved";
  await acts.persistStatus(orgId, key, "approved");
  const comms = await acts.sendComms(orgId, key, state.draft ?? "", state.alternatives);
  state.status = "comms_sent";
  state.commsDelivered = comms.delivered;
  await acts.persistStatus(orgId, key, "comms_sent", { delivered: comms.delivered });

  // Monitor until the feed resolves the shortage — the long-horizon leg (weeks–months).
  // Ticks weekly (durable across worker restarts/deploys) so monitoringWeeks reflects real
  // elapsed time; auto-escalates to exception if unresolved past MAX_MONITORING_MS total.
  state.status = "monitoring";
  await acts.persistStatus(orgId, key, "monitoring");
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
      await acts.persistStatus(orgId, key, "monitoring", { monitoringWeeks: state.monitoringWeeks });
    }
  }
  const deadlineHit = !state.resolved;
  if (deadlineHit) {
    state.status = "exception";
    await acts.persistStatus(orgId, key, "exception", { reason: "monitoring-timeout" });
    return state;
  }

  // Resolved → draft reversion, then close.
  state.status = "reverting";
  await acts.persistStatus(orgId, key, "reverting");
  state.status = "closed";
  await acts.persistStatus(orgId, key, "closed");
  return state;
}

/**
 * The feed-poll workflow (PROJECT_PLAN §4: "poll → new shortage auto-opens a case"). One
 * run = one poll of openFDA + ASHP; a Temporal Schedule (`scripts/start-schedule.ts`) fires
 * it on a cadence so new shortages open cases without a human running `start-case` by hand.
 */
export async function pollFeedsWorkflow(): Promise<{ polled: number; opened: number; resolved: number }> {
  return acts.pollAndOpenCases();
}

/**
 * The audit-anchor workflow (PHASE6 §6.2). One run = one external anchor of EVERY organization's
 * chain head (per-org since §6.5 pass 2 — with one chain per tenant, a single "head hash" is
 * ambiguous). A separate hourly Temporal Schedule fires it (`scripts/start-schedule.ts`) so
 * wholesale chain rewrites stay detectable even to someone holding the HMAC key.
 */
export async function anchorAuditWorkflow(): Promise<
  { orgId: string; maxAuditId: number; headHash: string; sink: string }[]
> {
  return acts.anchorAuditChain();
}

/**
 * The daily-brief workflow (ticket 13). One run = one brief per tenant, on the SAME Temporal spine
 * the feed poll and the audit anchor already run on. No second orchestrator is introduced.
 */
export async function dailyBriefWorkflow(): Promise<{ generated: number; degraded: number }> {
  return briefActs.generateDailyBriefs();
}
